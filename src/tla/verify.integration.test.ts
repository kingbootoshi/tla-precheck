import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { resolveMachine } from "../core/proof.js";
import { agentRunsMachine } from "../examples/agentRuns.machine.js";
import { dogMachine } from "../examples/dog.machine.js";
import { writeGeneratedMachine } from "./generate.js";
import { verifyGeneratedMachineArtifacts } from "./verify.js";

const tlaJar = process.env.TLA2TOOLS_JAR;

const withGeneratedMachine = async (
  machineName: "dog" | "agentRuns",
  mutate: (tlaPath: string) => Promise<void>
) => {
  const tempDir = await mkdtemp(join(tmpdir(), "tla-precheck-verify-"));
  try {
    const machine =
      machineName === "dog"
        ? resolveMachine(dogMachine, "pr")
        : resolveMachine(agentRunsMachine, "pr");
    const generated = await writeGeneratedMachine(machine, tempDir);
    await mutate(generated.tlaPath);
    const certificate = await verifyGeneratedMachineArtifacts(machine, generated);
    return certificate;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
};

describe("TLA verification integration", () => {
  test("fails proof when Spec is sabotaged", async () => {
    if (tlaJar === undefined || tlaJar.length === 0) {
      return;
    }

    const certificate = await withGeneratedMachine("dog", async (tlaPath) => {
      const source = await readFile(tlaPath, "utf8");
      const mutated = source.replace(
        /\nNext ==\n[\s\S]*?\n\nEquivalenceNext ==\n/,
        "\nNext ==\n  FALSE\n\nEquivalenceNext ==\n"
      );
      assert.notEqual(mutated, source);
      await writeFile(tlaPath, mutated, "utf8");
    });

    assert.equal(certificate.proofPassed, false);
    assert.equal(certificate.graphEquivalenceAttempted, false);
    assert.equal(certificate.equivalent, null);
  });

  test("fails graph equivalence when EquivalenceSpec is sabotaged", async () => {
    if (tlaJar === undefined || tlaJar.length === 0) {
      return;
    }

    const certificate = await withGeneratedMachine("agentRuns", async (tlaPath) => {
      const source = await readFile(tlaPath, "utf8");
      const mutated = source.replace(
        /\nEquivalenceNext ==\n[\s\S]*?\n\nSpec == /,
        "\nEquivalenceNext ==\n  FALSE\n\nSpec == "
      );
      assert.notEqual(mutated, source);
      await writeFile(tlaPath, mutated, "utf8");
    });

    assert.equal(certificate.proofPassed, true);
    assert.equal(certificate.graphEquivalenceAttempted, true);
    assert.equal(certificate.equivalent, false);
  });
});
