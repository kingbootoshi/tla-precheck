import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { MachineDef } from "../core/dsl.js";
import { assertWithinBudgets, estimateMachine, formatEstimate, resolveMachine } from "../core/proof.js";
import {
  verifyPostgresStorageContract,
  writeGeneratedStorageContract
} from "../db/postgres.js";
import { exploreGraph } from "../core/interpreter.js";
import { lintNoRawMachineWrites } from "../lint/noRawMachineWrites.js";
import { compareGraphs } from "../tla/compare.js";
import { generateCfg, writeGeneratedMachine } from "../tla/generate.js";
import { parseTlcDot } from "../tla/parseDot.js";

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ParsedArgs {
  command: "estimate" | "generate" | "generate-db" | "lint" | "verify" | "verify-db";
  modulePath: string;
  tier?: string;
  outputRoot: string;
  tsconfigPath: string;
}

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

const loadMachine = async (modulePath: string): Promise<MachineDef> => {
  const absolute = resolve(modulePath);
  const loaded = (await import(pathToFileURL(absolute).href)) as Record<string, unknown>;
  const machine = (loaded.default ?? loaded.machine ?? Object.values(loaded)[0]) as MachineDef | undefined;
  if (machine === undefined) {
    throw new Error(`Could not find a machine export in ${absolute}`);
  }
  return machine;
};

const parseArgs = (argv: readonly string[]): ParsedArgs => {
  const command = argv[2];
  const modulePath = argv[3];

  if (
    command !== "estimate" &&
    command !== "generate" &&
    command !== "generate-db" &&
    command !== "lint" &&
    command !== "verify" &&
    command !== "verify-db"
  ) {
    throw new Error(
      "Usage: machine <estimate|generate|generate-db|lint|verify|verify-db> <compiled-machine-module.js> [--tier <name>] [--output-root <path>] [--tsconfig <path>]"
    );
  }

  if (modulePath === undefined) {
    throw new Error("Missing compiled machine module path");
  }

  let tier: string | undefined;
  let outputRoot = resolve(process.cwd(), ".generated-machines");
  let tsconfigPath = resolve(process.cwd(), "tsconfig.json");

  for (let index = 4; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--tier") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("Missing value for --tier");
      }
      tier = value;
      index += 1;
      continue;
    }

    if (flag === "--output-root") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("Missing value for --output-root");
      }
      outputRoot = resolve(value);
      index += 1;
      continue;
    }

    if (flag === "--tsconfig") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("Missing value for --tsconfig");
      }
      tsconfigPath = resolve(value);
      index += 1;
      continue;
    }

    throw new Error(`Unknown flag ${flag}`);
  }

  return {
    command,
    modulePath,
    tier,
    outputRoot,
    tsconfigPath
  };
};

const runEstimate = async (machine: MachineDef, tier?: string): Promise<void> => {
  const estimate = estimateMachine(machine, tier);
  console.log(formatEstimate(estimate));
  if (!estimate.withinBudget) {
    process.exitCode = 1;
  }
};

const runGenerate = async (
  machine: MachineDef,
  tier: string | undefined,
  outputRoot: string
): Promise<void> => {
  const resolvedMachine = resolveMachine(machine, tier);
  assertWithinBudgets(resolvedMachine.estimate);
  await mkdir(outputRoot, { recursive: true });
  const generated = await writeGeneratedMachine(resolvedMachine, outputRoot);

  console.log(
    JSON.stringify(
      {
        generated,
        tier: resolvedMachine.resolvedTier.name,
        estimate: resolvedMachine.estimate
      },
      null,
      2
    )
  );
};

const runVerify = async (
  machine: MachineDef,
  tier: string | undefined,
  outputRoot: string
): Promise<void> => {
  const tlaJar = process.env.TLA2TOOLS_JAR;
  if (tlaJar === undefined) {
    throw new Error("TLA2TOOLS_JAR must point to tla2tools.jar");
  }

  const resolvedMachine = resolveMachine(machine, tier);
  assertWithinBudgets(resolvedMachine.estimate);

  await mkdir(outputRoot, { recursive: true });
  const generated = await writeGeneratedMachine(resolvedMachine, outputRoot);
  const equivalenceCfgPath = resolve(
    generated.outputDir,
    `${resolvedMachine.moduleName}.equivalence.cfg`
  );
  await writeFile(
    equivalenceCfgPath,
    generateCfg(resolvedMachine, {
      includeSymmetry: false,
      specification: "EquivalenceSpec",
      stringifyModelValues: true
    }),
    "utf8"
  );
  const graphStem = resolve(generated.outputDir, resolvedMachine.moduleName);
  const graphPath = `${graphStem}.dot`;
  const metadir = resolve(generated.outputDir, ".tlc-meta");
  await mkdir(metadir, { recursive: true });

  const tsGraph = exploreGraph(resolvedMachine);

  let proofOutput = "";
  if (resolvedMachine.resolvedTier.symmetryDomains.length > 0) {
    const proofRun = await runCommand(
      "java",
      [
        "-jar",
        tlaJar,
        "-workers",
        "1",
        "-metadir",
        resolve(generated.outputDir, ".tlc-meta-proof"),
        "-config",
        `${resolvedMachine.moduleName}.cfg`,
        `${resolvedMachine.moduleName}.tla`
      ],
      generated.outputDir
    );

    proofOutput = [proofRun.stdout.trim(), proofRun.stderr.trim()].filter(Boolean).join("\n");
    if (proofRun.exitCode !== 0) {
      throw new Error(`TLC proof run failed with exit code ${proofRun.exitCode}\n${proofOutput}`);
    }
  }

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

  const equivalenceOutput = [equivalenceRun.stdout.trim(), equivalenceRun.stderr.trim()]
    .filter(Boolean)
    .join("\n");
  if (equivalenceRun.exitCode !== 0) {
    throw new Error(
      `TLC equivalence run failed with exit code ${equivalenceRun.exitCode}\n${equivalenceOutput}`
    );
  }

  const dotSource = await readFile(graphPath, "utf8");
  const actionLabels = JSON.parse(
    await readFile(generated.actionLabelsPath, "utf8")
  ) as Record<string, string>;
  const tlcGraph = parseTlcDot(resolvedMachine, dotSource, actionLabels);
  const certificate = compareGraphs(
    resolvedMachine,
    tsGraph,
    tlcGraph,
    [proofOutput ? `Proof run:\n${proofOutput}` : "", `Equivalence run:\n${equivalenceOutput}`]
      .filter(Boolean)
      .join("\n\n")
  );
  const certificatePath = resolve(
    generated.outputDir,
    `${resolvedMachine.moduleName}.${resolvedMachine.resolvedTier.name}.certificate.json`
  );
  await writeFile(certificatePath, JSON.stringify(certificate, null, 2), "utf8");

  console.log(
    JSON.stringify(
      {
        generated,
        certificatePath,
        estimate: resolvedMachine.estimate,
        certificate
      },
      null,
      2
    )
  );

  if (!certificate.equivalent) {
    process.exitCode = 1;
  }
};

const runGenerateDb = async (machine: MachineDef, outputRoot: string): Promise<void> => {
  await mkdir(outputRoot, { recursive: true });
  const generated = await writeGeneratedStorageContract(machine, outputRoot);

  console.log(
    JSON.stringify(
      {
        generated
      },
      null,
      2
    )
  );
};

const runLint = async (machine: MachineDef, tsconfigPath: string): Promise<void> => {
  const violations = lintNoRawMachineWrites(tsconfigPath, machine);
  console.log(JSON.stringify({ tsconfigPath, violations }, null, 2));
  if (violations.length > 0) {
    process.exitCode = 1;
  }
};

const runVerifyDb = async (machine: MachineDef, outputRoot: string): Promise<void> => {
  await mkdir(outputRoot, { recursive: true });
  const generated = await writeGeneratedStorageContract(machine, outputRoot);
  const certificate = await verifyPostgresStorageContract(machine);
  const certificatePath = resolve(
    generated.outputDir,
    `${machine.moduleName}.postgres.certificate.json`
  );
  await writeFile(certificatePath, JSON.stringify(certificate, null, 2), "utf8");

  console.log(
    JSON.stringify(
      {
        generated,
        certificatePath,
        certificate
      },
      null,
      2
    )
  );

  if (!certificate.verified) {
    process.exitCode = 1;
  }
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const machine = await loadMachine(args.modulePath);

  if (args.command === "estimate") {
    await runEstimate(machine, args.tier);
    return;
  }

  if (args.command === "generate") {
    await runGenerate(machine, args.tier, args.outputRoot);
    return;
  }

  if (args.command === "generate-db") {
    await runGenerateDb(machine, args.outputRoot);
    return;
  }

  if (args.command === "lint") {
    await runLint(machine, args.tsconfigPath);
    return;
  }

  if (args.command === "verify-db") {
    await runVerifyDb(machine, args.outputRoot);
    return;
  }

  await runVerify(machine, args.tier, args.outputRoot);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
