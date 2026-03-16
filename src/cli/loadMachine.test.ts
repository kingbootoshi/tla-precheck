import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, test } from "node:test";

import { loadMachine, resolveMachineModulePath } from "./loadMachine.js";

const FIXTURE_ROOT = resolve(process.cwd(), ".generated-machines", "test-source-machines");
const TSCONFIG_PATH = resolve(process.cwd(), "tsconfig.json");

const writeFixtureMachine = async (): Promise<string> => {
  await mkdir(FIXTURE_ROOT, { recursive: true });

  const valuesPath = resolve(FIXTURE_ROOT, "loadMachineFixtureValues.ts");
  await writeFile(valuesPath, 'export const ACTIVE = "active";\n', "utf8");

  const machinePath = resolve(FIXTURE_ROOT, "loadMachineFixture.machine.ts");
  await writeFile(
    machinePath,
    `import { defineMachine, enumType, eq, lit, scalarVar, setVar, variable } from "../../src/core/dsl.js";
import { ACTIVE } from "./loadMachineFixtureValues.js";

const status = variable("status");

export default defineMachine({
  version: 2,
  moduleName: "LoadMachineFixture",
  variables: {
    status: scalarVar(enumType("draft", ACTIVE), lit("draft"))
  },
  actions: {
    activate: {
      params: {},
      guard: eq(status, lit("draft")),
      updates: [setVar("status", lit(ACTIVE))]
    }
  },
  invariants: {},
  proof: {
    defaultTier: "pr",
    tiers: {
      pr: {
        domains: {},
        budgets: {
          maxEstimatedStates: 10,
          maxEstimatedBranching: 1
        }
      }
    }
  }
});
`,
    "utf8"
  );

  return machinePath;
};

describe("loadMachine", () => {
  test("loads source .machine.ts files by emitting project-local JavaScript", async () => {
    const machinePath = await writeFixtureMachine();
    const machine = await loadMachine(machinePath, TSCONFIG_PATH);

    assert.equal(machine.moduleName, "LoadMachineFixture");
    assert.notEqual(machine.actions.activate, undefined);
    assert.equal(machine.variables.status.kind, "scalar");
  });

  test("resolves bare machine names to .machine.ts files", async () => {
    const machinePath = await writeFixtureMachine();
    const bareModulePath = machinePath.replace(/\.machine\.ts$/, "");

    assert.equal(resolveMachineModulePath(bareModulePath), machinePath);
  });
});
