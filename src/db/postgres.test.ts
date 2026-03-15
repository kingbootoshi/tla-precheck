import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  col,
  defineMachine,
  enumType,
  inSet,
  lit,
  pgUniqueWhere,
  scalarVar
} from "../core/dsl.js";
import { agentRunsMachine } from "../examples/agentRuns.machine.js";
import { renderPostgresStorageContract, renderPostgresStorageSql } from "./postgres.js";

describe("Postgres storage contracts", () => {
  test("renders canonical DDL with hash-stamped comments", () => {
    const contract = renderPostgresStorageContract(agentRunsMachine);
    const sql = renderPostgresStorageSql(agentRunsMachine);

    assert.equal(contract.length, 2);
    assert.match(
      sql,
      /CREATE UNIQUE INDEX "agent_runs_one_active_per_user" ON "public"\."agent_runs" \("owner"\) WHERE "status" IN \('queued', 'running'\);/
    );
    assert.match(sql, /COMMENT ON INDEX "public"\."agent_runs_one_active_per_user" IS 'tla-precheck:postgres:v1:/);
    assert.match(
      sql,
      /ALTER TABLE "public"\."agent_runs" ADD CONSTRAINT "agent_runs_active_requires_owner" CHECK/
    );
    assert.match(
      sql,
      /COMMENT ON CONSTRAINT "agent_runs_active_requires_owner" ON "public"\."agent_runs" IS 'tla-precheck:postgres:v1:/
    );
  });

  test("rejects storage constraints that reference unknown invariants", () => {
    const brokenMachine = defineMachine({
      version: 2,
      moduleName: "BrokenStorage",
      variables: {
        status: scalarVar(enumType("idle", "queued"), lit("idle"))
      },
      actions: {},
      invariants: {},
      proof: {
        defaultTier: "pr",
        tiers: {
          pr: {
            domains: {}
          }
        }
      },
      metadata: {
        ownedTables: ["agent_runs"],
        storageConstraints: [
          pgUniqueWhere({
            name: "broken_index",
            table: "agent_runs",
            columns: ["owner"],
            where: inSet(col("status"), ["queued"]),
            backsInvariant: "missingInvariant"
          })
        ]
      }
    });

    assert.throws(
      () => renderPostgresStorageContract(brokenMachine),
      /\[storage-unknown-invariant\] metadata\.storageConstraints\[0\]\.backsInvariant: Unknown backing invariant "missingInvariant"/
    );
  });
});
