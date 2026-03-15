import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { agentRunsMachine } from "../examples/agentRuns.machine.js";
import {
  applyPostgresStorageContract,
  renderPostgresStorageContract,
  verifyPostgresStorageContract
} from "./postgres.js";

interface SqlClient {
  <Row extends Record<string, unknown> = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: readonly unknown[]
  ): Promise<Row[]>;
  unsafe<Row extends Record<string, unknown> = Record<string, unknown>>(
    query: string
  ): Promise<Row[]>;
  begin<T>(fn: (sql: SqlClient) => Promise<T>): Promise<T>;
  close(): Promise<void> | void;
}

interface BunRuntimeWithSql {
  SQL: new (connectionString?: string) => SqlClient;
}

const databaseUrl = process.env.DATABASE_URL;

const getSqlClient = (): SqlClient => {
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL must be set for postgres integration tests");
  }

  const candidate = (globalThis as { Bun?: Partial<BunRuntimeWithSql> }).Bun;
  if (candidate === undefined || typeof candidate.SQL !== "function") {
    throw new Error("Postgres integration tests must run under Bun");
  }

  return new candidate.SQL(databaseUrl);
};

const resetAgentRunsTable = async (): Promise<void> => {
  const sql = getSqlClient();
  try {
    await sql.unsafe(`DROP TABLE IF EXISTS public.agent_runs CASCADE;`);
    await sql.unsafe(`
      CREATE TABLE public.agent_runs (
        id BIGSERIAL PRIMARY KEY,
        owner TEXT,
        status TEXT NOT NULL
      );
    `);
  } finally {
    await sql.close();
  }
};

const dropAgentRunsTable = async (): Promise<void> => {
  const sql = getSqlClient();
  try {
    await sql.unsafe(`DROP TABLE IF EXISTS public.agent_runs CASCADE;`);
  } finally {
    await sql.close();
  }
};

const executeStatements = async (statements: readonly string[]): Promise<void> => {
  const sql = getSqlClient();
  try {
    for (const statement of statements) {
      await sql.unsafe(statement);
    }
  } finally {
    await sql.close();
  }
};

const loadRenderedConstraint = (name: string) => {
  const result = renderPostgresStorageContract(agentRunsMachine).find(
    (entry) => entry.constraint.name === name
  );
  assert.ok(result, `Expected rendered storage constraint ${name}`);
  return result;
};

const findConstraintResult = (
  certificate: Awaited<ReturnType<typeof verifyPostgresStorageContract>>,
  name: string
) => {
  const result = certificate.constraints.find((constraint) => constraint.name === name);
  assert.ok(result, `Expected verification result for ${name}`);
  return result;
};

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "errno" in error &&
  typeof error.errno === "string" &&
  error.errno === "23505" &&
  "constraint" in error &&
  error.constraint === "agent_runs_one_active_per_user";

describe("Postgres integration", () => {
  test(
    "verify-db matches the live schema after applying the generated contract",
    async () => {
      if (databaseUrl === undefined || databaseUrl.length === 0) {
        return;
      }

      try {
        await resetAgentRunsTable();
        await applyPostgresStorageContract(agentRunsMachine, databaseUrl);

        const certificate = await verifyPostgresStorageContract(agentRunsMachine, databaseUrl);

        assert.equal(certificate.verified, true);
        assert.equal(certificate.constraints.length, 2);
        assert.ok(certificate.constraints.every((constraint) => constraint.present));
        assert.ok(certificate.constraints.every((constraint) => constraint.hashMatched));
        assert.ok(certificate.constraints.every((constraint) => constraint.valid));
        assert.ok(certificate.constraints.every((constraint) => constraint.predicateMatched));
        assert.ok(certificate.constraints.every((constraint) => constraint.flagsMatched));
        assert.ok(certificate.constraints.every((constraint) => constraint.typeCoverageMatched));
      } finally {
        await dropAgentRunsTable();
      }
    }
  );

  test(
    "the partial unique index rejects concurrent active rows for the same owner",
    async () => {
      if (databaseUrl === undefined || databaseUrl.length === 0) {
        return;
      }

      try {
        await resetAgentRunsTable();
        await applyPostgresStorageContract(agentRunsMachine, databaseUrl);

        const writerA = getSqlClient();
        const writerB = getSqlClient();

        let releaseWriterA: (() => void) | undefined;
        const writerAHold = new Promise<void>((resolve) => {
          releaseWriterA = resolve;
        });

        let insertedByWriterA: (() => void) | undefined;
        const writerAInserted = new Promise<void>((resolve) => {
          insertedByWriterA = resolve;
        });

        const transactionA = writerA.begin(async (sql) => {
          await sql`
            INSERT INTO public.agent_runs (owner, status)
            VALUES ('u1', 'queued')
          `;
          insertedByWriterA?.();
          await writerAHold;
        });

        await writerAInserted;

        const transactionB = writerB.begin(async (sql) => {
          await sql`
            INSERT INTO public.agent_runs (owner, status)
            VALUES ('u1', 'running')
          `;
        });

        releaseWriterA?.();
        await transactionA;
        await assert.rejects(transactionB, isUniqueViolation);
        await writerA.close();
        await writerB.close();
      } finally {
        await dropAgentRunsTable();
      }
    }
  );

  test(
    "verify-db fails when the unique index predicate is wrong even if the hash comment matches",
    async () => {
      if (databaseUrl === undefined || databaseUrl.length === 0) {
        return;
      }

      const expectedIndex = loadRenderedConstraint("agent_runs_one_active_per_user");
      const expectedCheck = loadRenderedConstraint("agent_runs_active_requires_owner");

      try {
        await resetAgentRunsTable();
        await executeStatements(expectedCheck.statements);
        await executeStatements([
          `CREATE UNIQUE INDEX "agent_runs_one_active_per_user" ON "public"."agent_runs" ("owner") WHERE "status" IN ('queued');`,
          `COMMENT ON INDEX "public"."agent_runs_one_active_per_user" IS '${expectedIndex.comment}';`
        ]);

        const certificate = await verifyPostgresStorageContract(agentRunsMachine, databaseUrl);
        const indexResult = findConstraintResult(
          certificate,
          "agent_runs_one_active_per_user"
        );

        assert.equal(certificate.verified, false);
        assert.equal(indexResult.present, true);
        assert.equal(indexResult.hashMatched, true);
        assert.equal(indexResult.columnsMatched, true);
        assert.equal(indexResult.flagsMatched, true);
        assert.equal(indexResult.typeCoverageMatched, true);
        assert.equal(indexResult.predicateMatched, false);
      } finally {
        await dropAgentRunsTable();
      }
    }
  );

  test(
    "verify-db fails when the check predicate is wrong even if the hash comment matches",
    async () => {
      if (databaseUrl === undefined || databaseUrl.length === 0) {
        return;
      }

      const expectedIndex = loadRenderedConstraint("agent_runs_one_active_per_user");
      const expectedCheck = loadRenderedConstraint("agent_runs_active_requires_owner");

      try {
        await resetAgentRunsTable();
        await executeStatements(expectedIndex.statements);
        await executeStatements([
          `ALTER TABLE "public"."agent_runs" ADD CONSTRAINT "agent_runs_active_requires_owner" CHECK (TRUE);`,
          `COMMENT ON CONSTRAINT "agent_runs_active_requires_owner" ON "public"."agent_runs" IS '${expectedCheck.comment}';`
        ]);

        const certificate = await verifyPostgresStorageContract(agentRunsMachine, databaseUrl);
        const checkResult = findConstraintResult(
          certificate,
          "agent_runs_active_requires_owner"
        );

        assert.equal(certificate.verified, false);
        assert.equal(checkResult.present, true);
        assert.equal(checkResult.hashMatched, true);
        assert.equal(checkResult.flagsMatched, true);
        assert.equal(checkResult.typeCoverageMatched, true);
        assert.equal(checkResult.predicateMatched, false);
      } finally {
        await dropAgentRunsTable();
      }
    }
  );

  test(
    "verify-db fails when the index flags are wrong even if the predicate and hash comment match",
    async () => {
      if (databaseUrl === undefined || databaseUrl.length === 0) {
        return;
      }

      const expectedIndex = loadRenderedConstraint("agent_runs_one_active_per_user");
      const expectedCheck = loadRenderedConstraint("agent_runs_active_requires_owner");

      try {
        await resetAgentRunsTable();
        await executeStatements(expectedCheck.statements);
        await executeStatements([
          `CREATE INDEX "agent_runs_one_active_per_user" ON "public"."agent_runs" ("owner") WHERE "status" IN ('queued', 'running');`,
          `COMMENT ON INDEX "public"."agent_runs_one_active_per_user" IS '${expectedIndex.comment}';`
        ]);

        const certificate = await verifyPostgresStorageContract(agentRunsMachine, databaseUrl);
        const indexResult = findConstraintResult(
          certificate,
          "agent_runs_one_active_per_user"
        );

        assert.equal(certificate.verified, false);
        assert.equal(indexResult.present, true);
        assert.equal(indexResult.hashMatched, true);
        assert.equal(indexResult.columnsMatched, true);
        assert.equal(indexResult.predicateMatched, true);
        assert.equal(indexResult.typeCoverageMatched, true);
        assert.equal(indexResult.flagsMatched, false);
      } finally {
        await dropAgentRunsTable();
      }
    }
  );
});
