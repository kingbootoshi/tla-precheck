import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { agentRunsMachine } from "../examples/agentRuns.machine.js";
import {
  applyPostgresStorageContract,
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
      } finally {
        const sql = getSqlClient();
        try {
          await sql.unsafe(`DROP TABLE IF EXISTS public.agent_runs CASCADE;`);
        } finally {
          await sql.close();
        }
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
        const sql = getSqlClient();
        try {
          await sql.unsafe(`DROP TABLE IF EXISTS public.agent_runs CASCADE;`);
        } finally {
          await sql.close();
        }
      }
    }
  );
});
