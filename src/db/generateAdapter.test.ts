import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, test } from "node:test";

import {
  defineMachine,
  domainType,
  enumType,
  eq,
  ids,
  index,
  lit,
  mapVar,
  optionType,
  param,
  setMap,
  variable
} from "../core/dsl.js";
import { writeGeneratedAdapter } from "./generateAdapter.js";

const machineWithoutAdapterMetadata = defineMachine({
  version: 2,
  moduleName: "Billing",
  variables: {
    status: mapVar("Orders", enumType("idle", "processing"), lit("idle"))
  },
  actions: {
    submit: {
      params: { o: "Orders" },
      guard: eq(index(variable("status"), param("o")), lit("idle")),
      updates: [setMap("status", param("o"), lit("processing"))]
    }
  },
  invariants: {},
  proof: {
    defaultTier: "pr",
    tiers: {
      pr: {
        domains: {
          Orders: ids({ prefix: "o", size: 2 })
        }
      }
    }
  }
});

const adapterMachine = defineMachine({
  version: 2,
  moduleName: "AgentRuns",
  variables: {
    status: mapVar("Runs", enumType("idle", "queued"), lit("idle")),
    owner: mapVar("Runs", optionType(domainType("Users")), lit(null))
  },
  actions: {
    create: {
      params: { u: "Users", r: "Runs" },
      guard: eq(index(variable("status"), param("r")), lit("idle")),
      updates: [
        setMap("status", param("r"), lit("queued")),
        setMap("owner", param("r"), param("u"))
      ]
    },
    finish: {
      params: { r: "Runs" },
      guard: eq(index(variable("status"), param("r")), lit("queued")),
      updates: [setMap("status", param("r"), lit("idle"))]
    }
  },
  invariants: {},
  proof: {
    defaultTier: "pr",
    tiers: {
      pr: {
        domains: {
          Users: ids({ prefix: "u", size: 2 }),
          Runs: ids({ prefix: "r", size: 2 })
        }
      }
    }
  },
  metadata: {
    ownedTables: ["agent_runs"],
    ownedColumns: {
      agent_runs: ["status", "owner"]
    },
    runtimeAdapter: {
      table: "agent_runs",
      rowDomain: "Runs",
      keyColumn: "id",
      keySqlType: "bigint"
    }
  }
});

describe("adapter generation", () => {
  test("writes the deterministic default adapter path", async () => {
    const expectedPath = resolve(process.cwd(), "src/machine-adapters/AgentRuns.adapter.ts");

    try {
      const generated = await writeGeneratedAdapter(adapterMachine);
      assert.equal(generated.adapterPath, expectedPath);
    } finally {
      await rm(expectedPath, { force: true });
    }
  });

  test("embeds machine JSON and emits one exported function per action", async () => {
    const adapterPath = resolve(process.cwd(), "src/machine-adapters/AgentRuns.adapter.ts");

    try {
      await writeGeneratedAdapter(adapterMachine);
      const source = await readFile(adapterPath, "utf8");

      assert.match(source, /const machine = \{/);
      assert.match(source, /"moduleName": "AgentRuns"/);
      assert.match(source, /export const create = async/);
      assert.match(source, /export const finish = async/);
    } finally {
      await rm(adapterPath, { force: true });
    }
  });

  test("imports adapterRuntime and not the source machine module", async () => {
    const adapterPath = resolve(process.cwd(), "src/machine-adapters/AgentRuns.adapter.ts");

    try {
      await writeGeneratedAdapter(adapterMachine);
      const source = await readFile(adapterPath, "utf8");

      assert.match(source, /from "tla-precheck\/db\/adapterRuntime"/);
      assert.match(source, /import type \{ MachineDef \} from "tla-precheck"/);
      assert.doesNotMatch(source, /examples\/agentRuns\.machine/);
    } finally {
      await rm(adapterPath, { force: true });
    }
  });

  test("explains the metadata fix when adapter generation is requested without runtime metadata", async () => {
    await assert.rejects(
      () => writeGeneratedAdapter(machineWithoutAdapterMetadata),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /\[build-requires-runtime-adapter\]/);
        assert.match(error.message, /metadata\.runtimeAdapter/);
        assert.match(error.message, /ownedTables/);
        assert.match(error.message, /ownedColumns/);
        assert.match(error.message, /table: "billings"/);
        return true;
      }
    );
  });
});
