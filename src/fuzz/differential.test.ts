import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { describe, test } from "node:test";

import {
  and,
  count,
  defineMachine,
  domainType,
  enumType,
  eq,
  forall,
  ids,
  index,
  isin,
  lit,
  lte,
  mapVar,
  modelValues,
  not,
  optionType,
  or,
  param,
  scalarVar,
  setMap,
  setOf,
  setVar,
  variable,
  type MachineDef
} from "../core/dsl.js";
import { assertWithinBudgets, resolveMachine } from "../core/proof.js";
import { exploreGraph } from "../core/interpreter.js";
import { compareGraphs } from "../tla/compare.js";
import { generateCfg, writeGeneratedMachine } from "../tla/generate.js";
import { parseTlcDot } from "../tla/parseDot.js";

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface Rng {
  next(): number;
  int(max: number): number;
  bool(): boolean;
  pick<T>(values: readonly T[]): T;
}

const runFuzzTests = process.env.RUN_FUZZ_TESTS === "1";
const tlaJar = process.env.TLA2TOOLS_JAR;
const fuzzSeed = Number.parseInt(process.env.FUZZ_SEED ?? "424242", 10);
const fuzzCases = Number.parseInt(process.env.FUZZ_CASES ?? "24", 10);

const javaAvailable =
  runFuzzTests && spawnSync("java", ["-version"], { stdio: "ignore" }).status === 0;

const createRng = (seed: number): Rng => {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };

  return {
    next,
    int(max: number): number {
      if (max < 1) {
        throw new Error(`Expected max >= 1, received ${max}`);
      }
      return Math.floor(next() * max);
    },
    bool(): boolean {
      return next() >= 0.5;
    },
    pick<T>(values: readonly T[]): T {
      if (values.length === 0) {
        throw new Error("Cannot pick from an empty list");
      }
      return values[this.int(values.length)] as T;
    }
  };
};

const runCommand = (command: string, args: readonly string[], cwd: string): Promise<CommandResult> =>
  new Promise((resolveCommand, reject) => {
    const child = spawn(command, args, { cwd });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolveCommand({ exitCode: exitCode ?? -1, stdout, stderr });
    });
  });

const shuffled = <T>(values: readonly T[], rng: Rng): T[] => {
  const out = [...values];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const swapIndex = rng.int(index + 1);
    [out[index], out[swapIndex]] = [out[swapIndex] as T, out[index] as T];
  }
  return out;
};

const makeScalarMachine = (indexNumber: number, rng: Rng): MachineDef => {
  const phaseValues = shuffled(["idle", "armed", "running", "done"], rng).slice(0, 3);
  const hasFlag = rng.bool();
  const phase = variable("phase");
  const actions: MachineDef["actions"] = {
    advance: {
      params: {},
      guard: eq(phase, lit(phaseValues[0] as string)),
      updates: [setVar("phase", lit(phaseValues[1] as string))]
    },
    settle: {
      params: {},
      guard: eq(phase, lit(phaseValues[1] as string)),
      updates: [setVar("phase", lit(phaseValues[2] as string))]
    },
    reset: {
      params: {},
      guard: isin(phase, setOf(lit(phaseValues[1] as string), lit(phaseValues[2] as string))),
      updates: [setVar("phase", lit(phaseValues[0] as string))]
    }
  };

  const invariants: MachineDef["invariants"] = {};
  const variables: MachineDef["variables"] = {
    phase: scalarVar(enumType(...phaseValues), lit(phaseValues[0] as string))
  };

  if (hasFlag) {
    const flag = variable("flag");
    variables.flag = scalarVar({ kind: "boolean" }, lit(false));
    actions.enableFlag = {
      params: {},
      guard: and(eq(phase, lit(phaseValues[1] as string)), eq(flag, lit(false))),
      updates: [setVar("flag", lit(true))]
    };
    actions.disableFlag = {
      params: {},
      guard: eq(flag, lit(true)),
      updates: [setVar("flag", lit(false))]
    };
    actions.reset.updates = [...actions.reset.updates, setVar("flag", lit(false))];
    invariants.flagOnlyAfterAdvance = {
      description: "Flag can only be set after the initial phase has been left",
      formula: or(not(eq(flag, lit(true))), not(eq(phase, lit(phaseValues[0] as string))))
    };
  }

  return defineMachine({
    version: 2,
    moduleName: `FuzzScalar${indexNumber}`,
    variables,
    actions,
    invariants,
    proof: {
      defaultTier: "pr",
      tiers: {
        pr: {
          domains: {},
          checks: {
            deadlock: false
          },
          budgets: {
            maxEstimatedStates: 128,
            maxEstimatedBranching: 16
          }
        }
      }
    }
  });
};

const makeMapMachine = (indexNumber: number, rng: Rng): MachineDef => {
  const occupant = variable("occupant");
  const slotState = variable("slotState");
  const includeSwap = rng.bool();
  const actions: MachineDef["actions"] = {
    claim: {
      params: { slot: "Slots", actor: "Actors" },
      guard: and(
        eq(index(slotState, param("slot")), lit("idle")),
        eq(index(occupant, param("slot")), lit(null)),
        eq(
          count("Slots", "candidate", eq(index(occupant, param("candidate")), param("actor"))),
          lit(0)
        )
      ),
      updates: [
        setMap("slotState", param("slot"), lit("busy")),
        setMap("occupant", param("slot"), param("actor"))
      ]
    },
    release: {
      params: { slot: "Slots" },
      guard: eq(index(slotState, param("slot")), lit("busy")),
      updates: [
        setMap("slotState", param("slot"), lit("idle")),
        setMap("occupant", param("slot"), lit(null))
      ]
    }
  };

  if (includeSwap) {
    actions.swap = {
      params: { slot: "Slots", actor: "Actors" },
      guard: and(
        eq(index(slotState, param("slot")), lit("busy")),
        not(eq(index(occupant, param("slot")), param("actor"))),
        eq(
          count("Slots", "candidate", eq(index(occupant, param("candidate")), param("actor"))),
          lit(0)
        )
      ),
      updates: [setMap("occupant", param("slot"), param("actor"))]
    };
  }

  return defineMachine({
    version: 2,
    moduleName: `FuzzMap${indexNumber}`,
    variables: {
      occupant: mapVar("Slots", optionType(domainType("Actors")), lit(null)),
      slotState: mapVar("Slots", enumType("idle", "busy"), lit("idle"))
    },
    actions,
    invariants: {
      oneSlotPerActor: {
        description: "Each actor holds at most one slot",
        formula: forall(
          "Actors",
          "actor",
          lte(
            count("Slots", "slot", eq(index(occupant, param("slot")), param("actor"))),
            lit(1)
          )
        )
      },
      busyRequiresOccupant: {
        description: "Busy slots always have an occupant",
        formula: forall(
          "Slots",
          "slot",
          or(
            not(eq(index(slotState, param("slot")), lit("busy"))),
            not(eq(index(occupant, param("slot")), lit(null)))
          )
        )
      }
    },
    proof: {
      defaultTier: "pr",
      tiers: {
        pr: {
          domains: {
            Actors: modelValues("a", { size: 2, symmetry: false }),
            Slots: ids({ prefix: "s", size: 2 + (rng.bool() ? 0 : 1) })
          },
          checks: {
            deadlock: false
          },
          budgets: {
            maxEstimatedStates: 5_000,
            maxEstimatedBranching: 24
          }
        }
      }
    }
  });
};

const makeFuzzMachine = (indexNumber: number, seed: number): MachineDef => {
  const rng = createRng(seed);
  return rng.bool() ? makeScalarMachine(indexNumber, rng) : makeMapMachine(indexNumber, rng);
};

const verifyMachine = async (machine: MachineDef): Promise<void> => {
  if (tlaJar === undefined) {
    throw new Error("TLA2TOOLS_JAR must be set to run fuzz tests");
  }

  const resolvedMachine = resolveMachine(machine, "pr");
  assertWithinBudgets(resolvedMachine.estimate);

  const outputRoot = resolve(process.cwd(), ".generated-machines", "fuzz");
  await mkdir(outputRoot, { recursive: true });
  const generated = await writeGeneratedMachine(resolvedMachine, outputRoot);
  const equivalenceCfgPath = resolve(
    generated.outputDir,
    `${resolvedMachine.moduleName}.equivalence.cfg`
  );
  const graphStem = resolve(generated.outputDir, resolvedMachine.moduleName);
  const graphPath = `${graphStem}.dot`;
  const metadir = resolve(generated.outputDir, ".tlc-meta");

  await mkdir(metadir, { recursive: true });
  await writeFile(
    equivalenceCfgPath,
    generateCfg(resolvedMachine, {
      includeSymmetry: false,
      specification: "EquivalenceSpec",
      stringifyModelValues: true
    }),
    "utf8"
  );

  const tsGraph = exploreGraph(resolvedMachine);
  const equivalenceRun = await runCommand(
    "java",
    [
      "-jar",
      tlaJar,
      "-workers",
      "1",
      "-metadir",
      metadir,
      "-dump",
      "dot,actionlabels",
      graphStem,
      "-config",
      equivalenceCfgPath,
      `${resolvedMachine.moduleName}.tla`
    ],
    generated.outputDir
  );

  const tlcOutput = [equivalenceRun.stdout.trim(), equivalenceRun.stderr.trim()]
    .filter(Boolean)
    .join("\n");
  if (equivalenceRun.exitCode !== 0) {
    throw new Error(
      `TLC fuzz run failed for ${resolvedMachine.moduleName} with exit code ${equivalenceRun.exitCode}\n${tlcOutput}`
    );
  }

  const dotSource = await readFile(graphPath, "utf8");
  const actionLabels = JSON.parse(
    await readFile(generated.actionLabelsPath, "utf8")
  ) as Record<string, string>;
  const tlcGraph = parseTlcDot(resolvedMachine, dotSource, actionLabels);
  const certificate = compareGraphs(resolvedMachine, tsGraph, tlcGraph, tlcOutput);

  assert.equal(
    certificate.equivalent,
    true,
    JSON.stringify(
      {
        machine: resolvedMachine.moduleName,
        tier: resolvedMachine.resolvedTier.name,
        outputDir: generated.outputDir,
        tsStateCount: certificate.tsStateCount,
        tlcStateCount: certificate.tlcStateCount,
        tsEdgeCount: certificate.tsEdgeCount,
        tlcEdgeCount: certificate.tlcEdgeCount,
        tlcOutput
      },
      null,
      2
    )
  );
};

describe("compiler differential fuzzing", () => {
  test(`generated machines stay equivalent across ${fuzzCases} cases`, { timeout: 120_000 }, async () => {
    if (!runFuzzTests || !javaAvailable || tlaJar === undefined) {
      return;
    }

    const baseSeed = Number.isNaN(fuzzSeed) ? 424242 : fuzzSeed;
    const caseCount = Number.isNaN(fuzzCases) ? 24 : fuzzCases;

    for (let indexNumber = 0; indexNumber < caseCount; indexNumber += 1) {
      const machineSeed = baseSeed + indexNumber * 17;
      const machine = makeFuzzMachine(indexNumber, machineSeed);
      try {
        await verifyMachine(machine);
      } catch (error) {
        throw new Error(
          `Fuzz case failed for ${machine.moduleName} with seed ${machineSeed}\n${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  });
});
