import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  JsonValue,
  MachineDef,
  PgCheckConstraintDef,
  PgUniqueWhereConstraintDef,
  Primitive,
  RowPredicateExpr,
  RowValueExpr,
  StorageConstraintDef
} from "../core/dsl.js";
import { stableStringify } from "../core/stable.js";

const POSTGRES_CONTRACT_PREFIX = "tla-precheck:postgres:v1";

interface SqlClient {
  <Row = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: readonly unknown[]
  ): Promise<Row[]>;
  unsafe<Row = Record<string, unknown>>(
    query: string,
    values?: readonly unknown[]
  ): Promise<Row[]>;
  begin<T>(fn: (sql: SqlClient) => Promise<T>): Promise<T>;
  begin<T>(options: string, fn: (sql: SqlClient) => Promise<T>): Promise<T>;
  close(): Promise<void> | void;
}

interface BunRuntimeWithSql {
  SQL: new (connectionString?: string) => SqlClient;
}

interface IndexSnapshot {
  schema_name: string;
  table_name: string;
  object_name: string;
  is_unique: boolean;
  is_valid: boolean;
  comment: string | null;
  columns: string[] | null;
}

interface CheckSnapshot {
  schema_name: string;
  table_name: string;
  object_name: string;
  is_valid: boolean;
  comment: string | null;
}

export interface StorageConstraintRenderResult {
  constraint: StorageConstraintDef;
  hash: string;
  comment: string;
  statements: readonly string[];
}

export interface GeneratedStoragePaths {
  outputDir: string;
  sqlPath: string;
}

export interface StorageConstraintVerificationResult {
  name: string;
  kind: StorageConstraintDef["kind"];
  table: string;
  schema: string;
  backsInvariant?: string;
  present: boolean;
  valid: boolean;
  hashMatched: boolean;
  columnsMatched?: boolean;
}

export interface PostgresVerificationCertificate {
  certificateVersion: 1;
  machine: string;
  database: "postgres";
  verified: boolean;
  checkedAt: string;
  constraints: readonly StorageConstraintVerificationResult[];
}

const getBunRuntime = (): BunRuntimeWithSql => {
  const candidate = (globalThis as { Bun?: Partial<BunRuntimeWithSql> }).Bun;
  if (candidate === undefined || typeof candidate.SQL !== "function") {
    throw new Error("Postgres verification must run under Bun because it uses Bun.SQL");
  }
  return candidate as BunRuntimeWithSql;
};

const createSqlClient = (databaseUrl?: string): SqlClient => {
  const resolvedUrl = databaseUrl ?? process.env.DATABASE_URL;
  if (resolvedUrl === undefined || resolvedUrl.length === 0) {
    throw new Error("DATABASE_URL must be set for generate-db apply helpers and verify-db");
  }
  const bunRuntime = getBunRuntime();
  return new bunRuntime.SQL(resolvedUrl);
};

const quoteIdent = (value: string): string => `"${value.replaceAll("\"", "\"\"")}"`;

const sqlLiteral = (value: Primitive): string => {
  if (value === null) {
    return "NULL";
  }
  if (typeof value === "string") {
    return `'${value.replaceAll("'", "''")}'`;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return value ? "TRUE" : "FALSE";
};

const renderRowValueSql = (value: RowValueExpr): string => {
  switch (value.kind) {
    case "pgColumn":
      return quoteIdent(value.name);
    case "pgLiteral":
      return sqlLiteral(value.value);
  }
};

const renderRowPredicateSql = (predicate: RowPredicateExpr): string => {
  switch (predicate.kind) {
    case "pgEq":
      return `${renderRowValueSql(predicate.left)} = ${renderRowValueSql(predicate.right)}`;
    case "pgInSet":
      if (predicate.values.length === 0) {
        throw new Error("pgInSet requires at least one literal value");
      }
      if (predicate.values.some((value) => value === null)) {
        throw new Error("pgInSet does not support NULL values");
      }
      return `${renderRowValueSql(predicate.target)} IN (${predicate.values.map((value) => sqlLiteral(value)).join(", ")})`;
    case "pgAnd":
      return predicate.values.length === 0
        ? "TRUE"
        : predicate.values.map((value) => `(${renderRowPredicateSql(value)})`).join(" AND ");
    case "pgOr":
      return predicate.values.length === 0
        ? "FALSE"
        : predicate.values.map((value) => `(${renderRowPredicateSql(value)})`).join(" OR ");
    case "pgNot":
      return `NOT (${renderRowPredicateSql(predicate.value)})`;
    case "pgIsNull":
      return `${renderRowValueSql(predicate.value)} IS NULL`;
    case "pgIsNotNull":
      return `${renderRowValueSql(predicate.value)} IS NOT NULL`;
  }
};

const rowValueToHashJson = (
  value: RowValueExpr
): Primitive | { [key: string]: JsonValue } =>
  value.kind === "pgColumn" ? { kind: value.kind, name: value.name } : { kind: value.kind, value: value.value };

const rowPredicateToHashJson = (predicate: RowPredicateExpr): { [key: string]: JsonValue } => {
  switch (predicate.kind) {
    case "pgEq":
      return {
        kind: predicate.kind,
        left: rowValueToHashJson(predicate.left),
        right: rowValueToHashJson(predicate.right)
      };
    case "pgInSet":
      return {
        kind: predicate.kind,
        target: rowValueToHashJson(predicate.target),
        values: [...predicate.values]
      };
    case "pgAnd":
    case "pgOr":
      return {
        kind: predicate.kind,
        values: predicate.values.map((value) => rowPredicateToHashJson(value))
      };
    case "pgNot":
      return { kind: predicate.kind, value: rowPredicateToHashJson(predicate.value) };
    case "pgIsNull":
    case "pgIsNotNull":
      return { kind: predicate.kind, value: rowValueToHashJson(predicate.value) };
  }
};

const hashMaterial = (constraint: StorageConstraintDef): string => {
  const base: { [key: string]: JsonValue } =
    constraint.kind === "pgUniqueWhere"
      ? {
          kind: constraint.kind,
          schema: constraint.schema,
          table: constraint.table,
          columns: [...constraint.columns],
          where: rowPredicateToHashJson(constraint.where),
          backsInvariant: constraint.backsInvariant ?? null
        }
      : {
          kind: constraint.kind,
          schema: constraint.schema,
          table: constraint.table,
          predicate: rowPredicateToHashJson(constraint.predicate),
          backsInvariant: constraint.backsInvariant ?? null
        };

  return createHash("sha256").update(stableStringify(base)).digest("hex");
};

const constraintComment = (constraint: StorageConstraintDef): string =>
  `${POSTGRES_CONTRACT_PREFIX}:${hashMaterial(constraint)}`;

const validateStorageConstraints = (machine: MachineDef): readonly StorageConstraintDef[] => {
  const storageConstraints = machine.metadata?.storageConstraints ?? [];
  const ownedTables = new Set(machine.metadata?.ownedTables ?? []);
  const knownInvariants = new Set(Object.keys(machine.invariants));
  const seenNames = new Set<string>();

  for (const constraint of storageConstraints) {
    if (seenNames.has(`${constraint.schema}.${constraint.table}.${constraint.name}`)) {
      throw new Error(`Duplicate storage constraint ${constraint.schema}.${constraint.table}.${constraint.name}`);
    }
    seenNames.add(`${constraint.schema}.${constraint.table}.${constraint.name}`);

    if (constraint.backsInvariant !== undefined && !knownInvariants.has(constraint.backsInvariant)) {
      throw new Error(`Storage constraint ${constraint.name} references unknown invariant ${constraint.backsInvariant}`);
    }

    if (ownedTables.size > 0 && !ownedTables.has(constraint.table)) {
      throw new Error(`Storage constraint ${constraint.name} targets unowned table ${constraint.table}`);
    }

    if (constraint.kind === "pgUniqueWhere" && constraint.columns.length === 0) {
      throw new Error(`Storage constraint ${constraint.name} must declare at least one indexed column`);
    }
  }

  return storageConstraints;
};

const renderUniqueIndexStatements = (
  constraint: PgUniqueWhereConstraintDef
): StorageConstraintRenderResult => {
  const hash = hashMaterial(constraint);
  const comment = `${POSTGRES_CONTRACT_PREFIX}:${hash}`;
  const relationName = `${quoteIdent(constraint.schema)}.${quoteIdent(constraint.table)}`;
  const indexName = `${quoteIdent(constraint.schema)}.${quoteIdent(constraint.name)}`;
  return {
    constraint,
    hash,
    comment,
    statements: [
      `CREATE UNIQUE INDEX ${quoteIdent(constraint.name)} ON ${relationName} (${constraint.columns.map((column) => quoteIdent(column)).join(", ")}) WHERE ${renderRowPredicateSql(constraint.where)};`,
      `COMMENT ON INDEX ${indexName} IS ${sqlLiteral(comment)};`
    ]
  };
};

const renderCheckStatements = (constraint: PgCheckConstraintDef): StorageConstraintRenderResult => {
  const hash = hashMaterial(constraint);
  const comment = `${POSTGRES_CONTRACT_PREFIX}:${hash}`;
  const relationName = `${quoteIdent(constraint.schema)}.${quoteIdent(constraint.table)}`;
  return {
    constraint,
    hash,
    comment,
    statements: [
      `ALTER TABLE ${relationName} ADD CONSTRAINT ${quoteIdent(constraint.name)} CHECK (${renderRowPredicateSql(constraint.predicate)});`,
      `COMMENT ON CONSTRAINT ${quoteIdent(constraint.name)} ON ${relationName} IS ${sqlLiteral(comment)};`
    ]
  };
};

export const renderPostgresStorageContract = (
  machine: MachineDef
): readonly StorageConstraintRenderResult[] =>
  validateStorageConstraints(machine).map((constraint) =>
    constraint.kind === "pgUniqueWhere"
      ? renderUniqueIndexStatements(constraint)
      : renderCheckStatements(constraint)
  );

export const renderPostgresStorageSql = (machine: MachineDef): string =>
  renderPostgresStorageContract(machine)
    .flatMap((result) => result.statements)
    .join("\n\n");

export const writeGeneratedStorageContract = async (
  machine: MachineDef,
  outputRoot: string
): Promise<GeneratedStoragePaths> => {
  const outputDir = join(outputRoot, machine.moduleName, "db", "postgres");
  await mkdir(outputDir, { recursive: true });
  const sqlPath = join(outputDir, `${machine.moduleName}.postgres.sql`);
  await writeFile(sqlPath, `${renderPostgresStorageSql(machine)}\n`, "utf8");
  return { outputDir, sqlPath };
};

export const applyPostgresStorageContract = async (
  machine: MachineDef,
  databaseUrl?: string
): Promise<void> => {
  const sql = createSqlClient(databaseUrl);
  try {
    for (const statement of renderPostgresStorageContract(machine).flatMap((result) => result.statements)) {
      await sql.unsafe(statement);
    }
  } finally {
    await sql.close();
  }
};

const verifyUniqueIndex = async (
  sql: SqlClient,
  constraint: PgUniqueWhereConstraintDef
): Promise<StorageConstraintVerificationResult> => {
  const rows = await sql<IndexSnapshot>`
    SELECT
      ns.nspname AS schema_name,
      tbl.relname AS table_name,
      idx.relname AS object_name,
      ind.indisunique AS is_unique,
      ind.indisvalid AS is_valid,
      descr.description AS comment,
      ARRAY(
        SELECT attr.attname
        FROM unnest(ind.indkey) WITH ORDINALITY AS key(attnum, ord)
        JOIN pg_attribute AS attr
          ON attr.attrelid = tbl.oid
         AND attr.attnum = key.attnum
        ORDER BY key.ord
      ) AS columns
    FROM pg_class AS idx
    JOIN pg_index AS ind
      ON ind.indexrelid = idx.oid
    JOIN pg_class AS tbl
      ON tbl.oid = ind.indrelid
    JOIN pg_namespace AS ns
      ON ns.oid = tbl.relnamespace
    LEFT JOIN pg_description AS descr
      ON descr.objoid = idx.oid
     AND descr.classoid = 'pg_class'::regclass
     AND descr.objsubid = 0
    WHERE ns.nspname = ${constraint.schema}
      AND tbl.relname = ${constraint.table}
      AND idx.relname = ${constraint.name}
  `;

  const row = rows[0];
  if (row === undefined) {
    return {
      name: constraint.name,
      kind: constraint.kind,
      table: constraint.table,
      schema: constraint.schema,
      backsInvariant: constraint.backsInvariant,
      present: false,
      valid: false,
      hashMatched: false,
      columnsMatched: false
    };
  }

  const actualColumns = row.columns ?? [];
  const columnsMatched =
    actualColumns.length === constraint.columns.length &&
    actualColumns.every((value, index) => value === constraint.columns[index]);

  return {
    name: constraint.name,
    kind: constraint.kind,
    table: constraint.table,
    schema: constraint.schema,
    backsInvariant: constraint.backsInvariant,
    present: true,
    valid: row.is_unique && row.is_valid,
    hashMatched: row.comment === constraintComment(constraint),
    columnsMatched
  };
};

const verifyCheckConstraint = async (
  sql: SqlClient,
  constraint: PgCheckConstraintDef
): Promise<StorageConstraintVerificationResult> => {
  const rows = await sql<CheckSnapshot>`
    SELECT
      ns.nspname AS schema_name,
      tbl.relname AS table_name,
      con.conname AS object_name,
      con.convalidated AS is_valid,
      descr.description AS comment
    FROM pg_constraint AS con
    JOIN pg_class AS tbl
      ON tbl.oid = con.conrelid
    JOIN pg_namespace AS ns
      ON ns.oid = tbl.relnamespace
    LEFT JOIN pg_description AS descr
      ON descr.objoid = con.oid
     AND descr.classoid = 'pg_constraint'::regclass
     AND descr.objsubid = 0
    WHERE ns.nspname = ${constraint.schema}
      AND tbl.relname = ${constraint.table}
      AND con.conname = ${constraint.name}
      AND con.contype = 'c'
  `;

  const row = rows[0];
  if (row === undefined) {
    return {
      name: constraint.name,
      kind: constraint.kind,
      table: constraint.table,
      schema: constraint.schema,
      backsInvariant: constraint.backsInvariant,
      present: false,
      valid: false,
      hashMatched: false
    };
  }

  return {
    name: constraint.name,
    kind: constraint.kind,
    table: constraint.table,
    schema: constraint.schema,
    backsInvariant: constraint.backsInvariant,
    present: true,
    valid: row.is_valid,
    hashMatched: row.comment === constraintComment(constraint)
  };
};

export const verifyPostgresStorageContract = async (
  machine: MachineDef,
  databaseUrl?: string
): Promise<PostgresVerificationCertificate> => {
  const constraints = validateStorageConstraints(machine);
  const sql = createSqlClient(databaseUrl);

  try {
    const results: StorageConstraintVerificationResult[] = [];
    for (const constraint of constraints) {
      results.push(
        constraint.kind === "pgUniqueWhere"
          ? await verifyUniqueIndex(sql, constraint)
          : await verifyCheckConstraint(sql, constraint)
      );
    }

    return {
      certificateVersion: 1,
      machine: machine.moduleName,
      database: "postgres",
      verified: results.every(
        (result) =>
          result.present &&
          result.valid &&
          result.hashMatched &&
          (result.columnsMatched ?? true)
      ),
      checkedAt: new Date().toISOString(),
      constraints: results
    };
  } finally {
    await sql.close();
  }
};
