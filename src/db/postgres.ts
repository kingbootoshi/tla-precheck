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
import { assertValidMachine } from "../core/validate.js";
import {
  buildWitnessRows,
  collectRowPredicateColumns,
  evaluateRowPredicate3vl,
  type RowPredicateColumnKind,
  type RowPredicateColumnType,
  type ThreeValuedBoolean
} from "./rowPredicate.js";

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
  is_ready: boolean;
  is_live: boolean;
  nulls_not_distinct: boolean;
  comment: string | null;
  columns: string[] | null;
  predicate_sql: string | null;
}

interface CheckSnapshot {
  schema_name: string;
  table_name: string;
  object_name: string;
  is_valid: boolean;
  comment: string | null;
  predicate_sql: string | null;
}

interface ColumnTypeSnapshot {
  column_name: string;
  sql_type: string;
  type_name: string;
  type_category: string;
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
  predicateMatched?: boolean;
  flagsMatched?: boolean;
  typeCoverageMatched?: boolean;
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

const toThreeValuedBoolean = (value: unknown): ThreeValuedBoolean => {
  if (value === null || typeof value === "boolean") {
    return value;
  }
  throw new Error(`Expected PostgreSQL predicate result to be boolean or null, received ${JSON.stringify(value)}`);
};

const classifyColumnKind = (
  column: ColumnTypeSnapshot
): RowPredicateColumnKind | null => {
  if (column.type_category === "B") {
    return "boolean";
  }
  if (column.type_category === "N") {
    return "number";
  }
  if (column.type_category === "S" || column.type_name === "uuid") {
    return "string";
  }
  return null;
};

const loadPredicateColumnTypes = async (
  sql: SqlClient,
  schema: string,
  table: string,
  predicate: RowPredicateExpr
): Promise<Record<string, RowPredicateColumnType> | null> => {
  const columns = collectRowPredicateColumns(predicate);
  if (columns.length === 0) {
    return {};
  }

  const rows = await sql<ColumnTypeSnapshot>`
    SELECT
      attr.attname AS column_name,
      format_type(attr.atttypid, attr.atttypmod) AS sql_type,
      typ.typname AS type_name,
      typ.typcategory AS type_category
    FROM pg_attribute AS attr
    JOIN pg_class AS tbl
      ON tbl.oid = attr.attrelid
    JOIN pg_namespace AS ns
      ON ns.oid = tbl.relnamespace
    JOIN pg_type AS typ
      ON typ.oid = attr.atttypid
    WHERE ns.nspname = ${schema}
      AND tbl.relname = ${table}
      AND attr.attnum > 0
      AND NOT attr.attisdropped
  `;

  const rowsByName = new Map(rows.map((row) => [row.column_name, row]));
  const columnTypes: Record<string, RowPredicateColumnType> = {};

  for (const column of columns) {
    const row = rowsByName.get(column);
    if (row === undefined) {
      return null;
    }
    const kind = classifyColumnKind(row);
    if (kind === null) {
      return null;
    }
    columnTypes[column] = {
      kind,
      sqlType: row.sql_type
    };
  }

  return columnTypes;
};

const buildPredicateProbeQuery = (
  predicateSql: string,
  row: Record<string, Primitive>,
  columnTypes: Record<string, RowPredicateColumnType>
): { query: string; values: readonly Primitive[] } => {
  const columns = Object.keys(columnTypes).sort((left, right) => left.localeCompare(right));
  if (columns.length === 0) {
    return {
      query: `SELECT (${predicateSql}) AS result;`,
      values: []
    };
  }

  const selectList = columns
    .map(
      (column, index) =>
        `CAST($${index + 1} AS ${columnTypes[column].sqlType}) AS ${quoteIdent(column)}`
    )
    .join(", ");

  return {
    query: `WITH probe AS (SELECT ${selectList}) SELECT (${predicateSql}) AS result FROM probe;`,
    values: columns.map((column) => row[column])
  };
};

const verifyPredicateSemantics = async (
  sql: SqlClient,
  schema: string,
  table: string,
  expectedPredicate: RowPredicateExpr,
  actualPredicateSql: string | null
): Promise<{ predicateMatched: boolean; typeCoverageMatched: boolean }> => {
  if (actualPredicateSql === null) {
    return { predicateMatched: false, typeCoverageMatched: false };
  }

  const columnTypes = await loadPredicateColumnTypes(sql, schema, table, expectedPredicate);
  if (columnTypes === null) {
    return { predicateMatched: false, typeCoverageMatched: false };
  }

  const witnessRows = buildWitnessRows(expectedPredicate, columnTypes);
  for (const row of witnessRows) {
    const expected = evaluateRowPredicate3vl(expectedPredicate, row);
    const probe = buildPredicateProbeQuery(actualPredicateSql, row, columnTypes);
    const resultRows = await sql.unsafe<{ result: unknown }>(probe.query, probe.values);
    const actual = toThreeValuedBoolean(resultRows[0]?.result);
    if (actual !== expected) {
      return { predicateMatched: false, typeCoverageMatched: true };
    }
  }

  return { predicateMatched: true, typeCoverageMatched: true };
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
): readonly StorageConstraintRenderResult[] => {
  assertValidMachine(machine);
  return validateStorageConstraints(machine).map((constraint) =>
    constraint.kind === "pgUniqueWhere"
      ? renderUniqueIndexStatements(constraint)
      : renderCheckStatements(constraint)
  );
};

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
      ind.indisready AS is_ready,
      ind.indislive AS is_live,
      ind.indnullsnotdistinct AS nulls_not_distinct,
      descr.description AS comment,
      pg_get_expr(ind.indpred, ind.indrelid, false) AS predicate_sql,
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
  const predicateVerification = await verifyPredicateSemantics(
    sql,
    constraint.schema,
    constraint.table,
    constraint.where,
    row.predicate_sql
  );
  const flagsMatched =
    row.is_unique &&
    row.is_valid &&
    row.is_ready &&
    row.is_live &&
    !row.nulls_not_distinct;

  return {
    name: constraint.name,
    kind: constraint.kind,
    table: constraint.table,
    schema: constraint.schema,
    backsInvariant: constraint.backsInvariant,
    present: true,
    valid: row.is_valid,
    hashMatched: row.comment === constraintComment(constraint),
    columnsMatched,
    predicateMatched: predicateVerification.predicateMatched,
    flagsMatched,
    typeCoverageMatched: predicateVerification.typeCoverageMatched
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
      descr.description AS comment,
      pg_get_expr(con.conbin, con.conrelid, false) AS predicate_sql
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

  const predicateVerification = await verifyPredicateSemantics(
    sql,
    constraint.schema,
    constraint.table,
    constraint.predicate,
    row.predicate_sql
  );

  return {
    name: constraint.name,
    kind: constraint.kind,
    table: constraint.table,
    schema: constraint.schema,
    backsInvariant: constraint.backsInvariant,
    present: true,
    valid: row.is_valid,
    hashMatched: row.comment === constraintComment(constraint),
    predicateMatched: predicateVerification.predicateMatched,
    flagsMatched: row.is_valid,
    typeCoverageMatched: predicateVerification.typeCoverageMatched
  };
};

export const verifyPostgresStorageContract = async (
  machine: MachineDef,
  databaseUrl?: string
): Promise<PostgresVerificationCertificate> => {
  assertValidMachine(machine);
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
          (result.columnsMatched ?? true) &&
          (result.predicateMatched ?? true) &&
          (result.flagsMatched ?? true) &&
          (result.typeCoverageMatched ?? true)
      ),
      checkedAt: new Date().toISOString(),
      constraints: results
    };
  } finally {
    await sql.close();
  }
};
