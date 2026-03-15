import type { MachineDef, Primitive } from "../core/dsl.js";
import {
  buildInitialState,
  step,
  type ExecutableMachineDef,
  type MachineState
} from "../core/interpreter.js";
import { deepEqual } from "../core/stable.js";

export interface AdapterSqlClient {
  unsafe<Row = Record<string, unknown>>(
    query: string,
    values?: readonly unknown[]
  ): Promise<Row[]>;
  begin<T>(fn: (sql: AdapterSqlClient) => Promise<T>): Promise<T>;
}

export interface GeneratedAdapterSpec {
  schema: string;
  table: string;
  rowDomain: string;
  keyColumn: string;
  keySqlType: "text" | "uuid" | "bigint";
  variableColumns: readonly { variableName: string; columnName: string }[];
  actionRowLiteralKeys: Readonly<Record<string, readonly string[]>>;
}

export interface AdapterWriteResult {
  action: string;
  changedRowKeys: readonly string[];
}

export class MachineActionNotEnabledError extends Error {
  code = "machine-action-not-enabled" as const;
}

const quoteIdent = (value: string): string => `"${value.replaceAll("\"", "\"\"")}"`;

const quoteQualifiedTable = (schema: string, table: string): string =>
  `${quoteIdent(schema)}.${quoteIdent(table)}`;

const assertPrimitive = (value: unknown, label: string): Primitive => {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  throw new Error(`${label} must be a primitive, received ${JSON.stringify(value)}`);
};

const normalizeRowKey = (value: Primitive, label: string): string => {
  if (value === null || typeof value === "boolean") {
    throw new Error(`${label} must be a text-like row key, received ${JSON.stringify(value)}`);
  }
  return String(value);
};

const asMapState = (state: MachineState, variableName: string): Record<string, Primitive> => {
  const value = state[variableName];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Machine variable ${variableName} must be a map state`);
  }

  const mapState: Record<string, Primitive> = {};
  for (const [key, entry] of Object.entries(value)) {
    mapState[key] = assertPrimitive(entry, `State value for ${variableName}[${key}]`);
  }
  return mapState;
};

const buildExecutableMachine = (
  machine: MachineDef,
  domains: Record<string, readonly string[]>
): ExecutableMachineDef => ({
  moduleName: machine.moduleName,
  variables: machine.variables,
  actions: machine.actions,
  domains
});

const normalizeRuntimeEnv = (
  machine: MachineDef,
  spec: GeneratedAdapterSpec,
  actionName: string,
  env: Record<string, Primitive>
): Record<string, Primitive> => {
  const action = machine.actions[actionName];
  if (action === undefined) {
    throw new Error(`Unknown machine action ${actionName}`);
  }

  const normalizedEnv: Record<string, Primitive> = {};
  for (const [paramName, domainName] of Object.entries(action.params)) {
    const rawValue = env[paramName];
    if (rawValue === undefined) {
      throw new Error(`Missing runtime env value for action param ${paramName}`);
    }

    normalizedEnv[paramName] =
      domainName === spec.rowDomain
        ? normalizeRowKey(rawValue, `Action param ${paramName}`)
        : (() => {
            if (typeof rawValue !== "string") {
              throw new Error(`Action param ${paramName} for domain ${domainName} must be a string`);
            }
            return rawValue;
          })();
  }

  return normalizedEnv;
};

const collectRuntimeDomains = (
  machine: MachineDef,
  spec: GeneratedAdapterSpec,
  actionName: string,
  normalizedEnv: Record<string, Primitive>,
  loadedRowKeys: readonly string[]
): Record<string, readonly string[]> => {
  const action = machine.actions[actionName];
  if (action === undefined) {
    throw new Error(`Unknown machine action ${actionName}`);
  }

  const literalRowKeys = spec.actionRowLiteralKeys[actionName];
  if (literalRowKeys === undefined) {
    throw new Error(`Missing generated literal row keys for action ${actionName}`);
  }

  const rowKeys: string[] = [];
  const seenRowKeys = new Set<string>();
  const pushRowKey = (value: string): void => {
    if (!seenRowKeys.has(value)) {
      seenRowKeys.add(value);
      rowKeys.push(value);
    }
  };

  for (const rowKey of loadedRowKeys) {
    pushRowKey(rowKey);
  }

  const nonRowDomains = new Map<string, string>();
  for (const [paramName, domainName] of Object.entries(action.params)) {
    const rawValue = normalizedEnv[paramName];
    if (rawValue === undefined) {
      throw new Error(`Missing runtime env value for action param ${paramName}`);
    }

    if (domainName === spec.rowDomain) {
      pushRowKey(normalizeRowKey(rawValue, `Action param ${paramName}`));
      continue;
    }

    if (typeof rawValue !== "string") {
      throw new Error(`Action param ${paramName} for domain ${domainName} must be a string`);
    }

    const existingValue = nonRowDomains.get(domainName);
    if (existingValue !== undefined && existingValue !== rawValue) {
      throw new Error(
        `Runtime adapter cannot reconstruct domain ${domainName} from multiple env values`
      );
    }
    nonRowDomains.set(domainName, rawValue);
  }

  for (const literalKey of literalRowKeys) {
    pushRowKey(literalKey);
  }

  const domains: Record<string, readonly string[]> = {
    [spec.rowDomain]: rowKeys
  };

  for (const [domainName, value] of nonRowDomains) {
    domains[domainName] = [value];
  }

  return domains;
};

const overlayRowsIntoState = (
  state: MachineState,
  rows: readonly Record<string, unknown>[],
  spec: GeneratedAdapterSpec
): void => {
  for (const row of rows) {
    const rawRowKey = row[spec.keyColumn];
    if (rawRowKey === undefined) {
      throw new Error(`Locked row is missing key column ${spec.keyColumn}`);
    }
    const rowKey = normalizeRowKey(
      assertPrimitive(rawRowKey, `Locked row key ${spec.keyColumn}`),
      `Locked row key ${spec.keyColumn}`
    );

    for (const { variableName, columnName } of spec.variableColumns) {
      const mapState = asMapState(state, variableName);
      const cellValue = row[columnName];
      if (cellValue === undefined) {
        throw new Error(`Locked row is missing owned column ${columnName}`);
      }
      mapState[rowKey] = assertPrimitive(cellValue, `Locked row column ${columnName}`);
      state[variableName] = mapState;
    }
  }
};

interface RowMutation {
  rowKey: string;
  changedColumns: readonly { columnName: string; value: Primitive }[];
  fullRow: readonly { columnName: string; value: Primitive }[];
  exists: boolean;
}

const diffRows = (
  spec: GeneratedAdapterSpec,
  currentState: MachineState,
  nextState: MachineState,
  existingRowKeys: ReadonlySet<string>
): readonly RowMutation[] => {
  const firstVariable = spec.variableColumns[0];
  if (firstVariable === undefined) {
    throw new Error("Generated adapter spec must declare at least one variable column");
  }
  const rowDomainState = asMapState(nextState, firstVariable.variableName);
  const rowKeys = Object.keys(rowDomainState).sort((left, right) => left.localeCompare(right));
  const mutations: RowMutation[] = [];

  for (const rowKey of rowKeys) {
    const changedColumns: { columnName: string; value: Primitive }[] = [];
    const fullRow: { columnName: string; value: Primitive }[] = [];

    for (const { variableName, columnName } of spec.variableColumns) {
      const currentMap = asMapState(currentState, variableName);
      const nextMap = asMapState(nextState, variableName);
      const currentValue = currentMap[rowKey];
      const nextValue = nextMap[rowKey];
      fullRow.push({ columnName, value: nextValue });
      if (!deepEqual(currentValue, nextValue)) {
        changedColumns.push({ columnName, value: nextValue });
      }
    }

    if (changedColumns.length === 0) {
      continue;
    }

    mutations.push({
      rowKey,
      changedColumns,
      fullRow,
      exists: existingRowKeys.has(rowKey)
    });
  }

  return mutations;
};

const buildSelectQuery = (spec: GeneratedAdapterSpec): string => {
  const selectedColumns = [spec.keyColumn, ...spec.variableColumns.map((entry) => entry.columnName)];
  return [
    `SELECT ${selectedColumns.map((column) => quoteIdent(column)).join(", ")}`,
    `FROM ${quoteQualifiedTable(spec.schema, spec.table)}`,
    `ORDER BY ${quoteIdent(spec.keyColumn)}`,
    "FOR UPDATE"
  ].join(" ");
};

const buildUpdateQuery = (
  spec: GeneratedAdapterSpec,
  mutation: RowMutation
): { query: string; values: readonly Primitive[] } => {
  const assignments = mutation.changedColumns.map(
    (column, index) => `${quoteIdent(column.columnName)} = $${index + 1}`
  );
  const values = mutation.changedColumns.map((column) => column.value);
  values.push(mutation.rowKey);
  return {
    query: [
      `UPDATE ${quoteQualifiedTable(spec.schema, spec.table)}`,
      `SET ${assignments.join(", ")}`,
      `WHERE ${quoteIdent(spec.keyColumn)} = $${mutation.changedColumns.length + 1}`
    ].join(" "),
    values
  };
};

const buildInsertQuery = (
  spec: GeneratedAdapterSpec,
  mutation: RowMutation
): { query: string; values: readonly Primitive[] } => {
  const columns = [spec.keyColumn, ...mutation.fullRow.map((column) => column.columnName)];
  const values = [mutation.rowKey, ...mutation.fullRow.map((column) => column.value)];
  return {
    query: [
      `INSERT INTO ${quoteQualifiedTable(spec.schema, spec.table)}`,
      `(${columns.map((column) => quoteIdent(column)).join(", ")})`,
      `VALUES (${values.map((_, index) => `$${index + 1}`).join(", ")})`
    ].join(" "),
    values
  };
};

export const applyGeneratedAction = async (
  sql: AdapterSqlClient,
  machine: MachineDef,
  spec: GeneratedAdapterSpec,
  actionName: string,
  env: Record<string, Primitive>
): Promise<AdapterWriteResult> =>
  sql.begin(async (tx) => {
    const rows = await tx.unsafe<Record<string, unknown>>(buildSelectQuery(spec));
    const loadedRowKeys = rows.map((row) => {
      const rowKey = row[spec.keyColumn];
      if (rowKey === undefined) {
        throw new Error(`Locked row is missing key column ${spec.keyColumn}`);
      }
      return normalizeRowKey(assertPrimitive(rowKey, `Locked row key ${spec.keyColumn}`), spec.keyColumn);
    });

    const normalizedEnv = normalizeRuntimeEnv(machine, spec, actionName, env);
    const domains = collectRuntimeDomains(machine, spec, actionName, normalizedEnv, loadedRowKeys);
    const executableMachine = buildExecutableMachine(machine, domains);
    const currentState = buildInitialState(executableMachine);
    overlayRowsIntoState(currentState, rows, spec);

    const nextState = step(executableMachine, currentState, actionName, normalizedEnv);
    if (nextState === null) {
      throw new MachineActionNotEnabledError(`Machine action ${actionName} is not enabled`);
    }

    const mutations = diffRows(spec, currentState, nextState, new Set(loadedRowKeys));
    for (const mutation of mutations) {
      const statement = mutation.exists
        ? buildUpdateQuery(spec, mutation)
        : buildInsertQuery(spec, mutation);
      await tx.unsafe(statement.query, statement.values);
    }

    return {
      action: actionName,
      changedRowKeys: mutations.map((mutation) => mutation.rowKey)
    };
  });
