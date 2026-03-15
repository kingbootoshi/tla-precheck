import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import type { ActionDef, Expr, MachineDef, Update, VariableDef } from "../core/dsl.js";
import { assertValidMachine } from "../core/validate.js";

export interface GeneratedAdapterPaths {
  outputDir: string;
  adapterPath: string;
}

const DEFAULT_ADAPTER_OUTPUT_ROOT = resolve(process.cwd(), "src/machine-adapters");

const toImportPath = (fromFile: string, targetFile: string): string => {
  const relativePath = relative(dirname(fromFile), targetFile).replaceAll("\\", "/");
  const withPrefix = relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
  return withPrefix.replace(/\.ts$/, ".js");
};

const toPascalCase = (value: string): string => value[0]!.toUpperCase() + value.slice(1);

const stringifyJson = (value: unknown): string => {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("Could not serialize generated adapter JSON");
  }
  return serialized;
};

const prettyStableJson = (value: unknown): string =>
  JSON.stringify(JSON.parse(stringifyJson(value)) as unknown, null, 2);

const envTypeForParam = (
  domainName: string,
  rowDomain: string,
  keySqlType: "text" | "uuid" | "bigint"
): string => {
  if (domainName !== rowDomain) {
    return "string";
  }
  return keySqlType === "bigint" ? "string | number | bigint" : "string";
};

const normalizedEnvValue = (paramName: string, domainName: string, rowDomain: string): string =>
  domainName === rowDomain ? `String(env.${paramName})` : `env.${paramName}`;

const collectLiteralRowKeysFromExpr = (
  expr: Expr,
  machine: MachineDef,
  rowDomain: string,
  into: Set<string>
): void => {
  switch (expr.kind) {
    case "lit":
    case "param":
    case "var":
      return;
    case "index":
      if (expr.target.kind === "var" && expr.key.kind === "lit" && typeof expr.key.value === "string") {
        const variable = machine.variables[expr.target.name];
        if (variable?.kind === "map" && variable.domain === rowDomain) {
          into.add(expr.key.value);
        }
      }
      collectLiteralRowKeysFromExpr(expr.target, machine, rowDomain, into);
      collectLiteralRowKeysFromExpr(expr.key, machine, rowDomain, into);
      return;
    case "set":
    case "and":
    case "or":
      for (const value of expr.values) {
        collectLiteralRowKeysFromExpr(value, machine, rowDomain, into);
      }
      return;
    case "not":
      collectLiteralRowKeysFromExpr(expr.value, machine, rowDomain, into);
      return;
    case "eq":
    case "lte":
      collectLiteralRowKeysFromExpr(expr.left, machine, rowDomain, into);
      collectLiteralRowKeysFromExpr(expr.right, machine, rowDomain, into);
      return;
    case "in":
      collectLiteralRowKeysFromExpr(expr.elem, machine, rowDomain, into);
      collectLiteralRowKeysFromExpr(expr.set, machine, rowDomain, into);
      return;
    case "count":
    case "forall":
      collectLiteralRowKeysFromExpr(expr.where, machine, rowDomain, into);
      return;
  }
};

const collectLiteralRowKeysFromUpdate = (
  update: Update,
  machine: MachineDef,
  rowDomain: string,
  into: Set<string>
): void => {
  if (update.kind === "setMap" && update.key.kind === "lit" && typeof update.key.value === "string") {
    const variable = machine.variables[update.name];
    if (variable?.kind === "map" && variable.domain === rowDomain) {
      into.add(update.key.value);
    }
  }

  if (update.kind === "setVar") {
    collectLiteralRowKeysFromExpr(update.value, machine, rowDomain, into);
    return;
  }

  collectLiteralRowKeysFromExpr(update.key, machine, rowDomain, into);
  collectLiteralRowKeysFromExpr(update.value, machine, rowDomain, into);
};

const collectActionRowLiteralKeys = (
  machine: MachineDef,
  action: ActionDef,
  rowDomain: string
): readonly string[] => {
  const keys = new Set<string>();
  collectLiteralRowKeysFromExpr(action.guard, machine, rowDomain, keys);
  for (const update of action.updates) {
    collectLiteralRowKeysFromUpdate(update, machine, rowDomain, keys);
  }
  return [...keys].sort((left, right) => left.localeCompare(right));
};

const mapVariableColumns = (machine: MachineDef): readonly { variableName: string; columnName: string }[] =>
  Object.keys(machine.variables).map((variableName) => ({
    variableName,
    columnName: variableName
  }));

const renderEnvInterface = (
  actionName: string,
  params: readonly [string, string][],
  rowDomain: string,
  keySqlType: "text" | "uuid" | "bigint"
): string | null => {
  if (params.length === 0) {
    return null;
  }

  const lines = [
    `export interface ${toPascalCase(actionName)}Env {`,
    ...params.map(
      ([paramName, domainName]) =>
        `  ${paramName}: ${envTypeForParam(domainName, rowDomain, keySqlType)};`
    ),
    "}"
  ];
  return lines.join("\n");
};

const renderActionFunction = (
  actionName: string,
  params: readonly [string, string][],
  rowDomain: string,
  keySqlType: "text" | "uuid" | "bigint"
): string => {
  if (params.length === 0) {
    return [
      `export const ${actionName} = async (sql: AdapterSqlClient): Promise<AdapterWriteResult> =>`,
      `  applyGeneratedAction(sql, machine, spec, "${actionName}", {});`
    ].join("\n");
  }

  const envAssignments = params.map(
    ([paramName, domainName]) =>
      `    ${paramName}: ${normalizedEnvValue(paramName, domainName, rowDomain)}`
  );

  return [
    `export const ${actionName} = async (`,
    "  sql: AdapterSqlClient,",
    `  env: ${toPascalCase(actionName)}Env`,
    "): Promise<AdapterWriteResult> =>",
    `  applyGeneratedAction(sql, machine, spec, "${actionName}", {`,
    envAssignments.join(",\n"),
    "  });"
  ].join("\n");
};

export const renderAdapterModule = (machine: MachineDef): string => {
  assertValidMachine(machine);
  const runtimeAdapter = machine.metadata?.runtimeAdapter;
  if (runtimeAdapter === undefined) {
    throw new Error(`Machine ${machine.moduleName} does not declare metadata.runtimeAdapter`);
  }

  const outputRoot = DEFAULT_ADAPTER_OUTPUT_ROOT;
  const adapterPath = join(outputRoot, `${machine.moduleName}.adapter.ts`);
  const dslImportPath = toImportPath(adapterPath, resolve(process.cwd(), "src/core/dsl.ts"));
  const runtimeImportPath = toImportPath(adapterPath, resolve(process.cwd(), "src/db/adapterRuntime.ts"));
  const machineJson = prettyStableJson(machine);
  const machineSha256 = createHash("sha256").update(stringifyJson(machine)).digest("hex");
  const variableColumns = mapVariableColumns(machine);
  const actionRowLiteralKeys = Object.fromEntries(
    Object.entries(machine.actions).map(([actionName, action]) => [
      actionName,
      collectActionRowLiteralKeys(machine, action, runtimeAdapter.rowDomain)
    ])
  );

  const renderedEnvInterfaces = Object.entries(machine.actions)
    .map(([actionName, action]) =>
      renderEnvInterface(
        actionName,
        Object.entries(action.params),
        runtimeAdapter.rowDomain,
        runtimeAdapter.keySqlType
      )
    )
    .filter((block): block is string => block !== null);

  const renderedActionFunctions = Object.entries(machine.actions).map(([actionName, action]) =>
    renderActionFunction(
      actionName,
      Object.entries(action.params),
      runtimeAdapter.rowDomain,
      runtimeAdapter.keySqlType
    )
  );

  return [
    "// Generated. Do not edit.",
    `// machine: ${machine.moduleName}`,
    `// machineSha256: ${machineSha256}`,
    "",
    `import type { MachineDef } from "${dslImportPath}";`,
    "import {",
    "  applyGeneratedAction,",
    "  type AdapterSqlClient,",
    "  type AdapterWriteResult,",
    "  type GeneratedAdapterSpec",
    `} from "${runtimeImportPath}";`,
    "",
    `const machine = ${machineJson} as const satisfies MachineDef;`,
    "",
    `const spec = ${prettyStableJson({
      schema: runtimeAdapter.schema ?? "public",
      table: runtimeAdapter.table,
      rowDomain: runtimeAdapter.rowDomain,
      keyColumn: runtimeAdapter.keyColumn,
      keySqlType: runtimeAdapter.keySqlType,
      variableColumns,
      actionRowLiteralKeys
    })} as const satisfies GeneratedAdapterSpec;`,
    "",
    ...renderedEnvInterfaces.flatMap((block) => [block, ""]),
    ...renderedActionFunctions.flatMap((block) => [block, ""]),
    "export default {",
    ...Object.keys(machine.actions).map((actionName) => `  ${actionName},`),
    "};"
  ].join("\n");
};

export const writeGeneratedAdapter = async (
  machine: MachineDef,
  outputRoot = DEFAULT_ADAPTER_OUTPUT_ROOT
): Promise<GeneratedAdapterPaths> => {
  assertValidMachine(machine);
  const runtimeAdapter = machine.metadata?.runtimeAdapter;
  if (runtimeAdapter === undefined) {
    throw new Error(`Machine ${machine.moduleName} does not declare metadata.runtimeAdapter`);
  }
  await mkdir(outputRoot, { recursive: true });
  const adapterPath = join(outputRoot, `${machine.moduleName}.adapter.ts`);
  await writeFile(adapterPath, renderAdapterModule(machine), "utf8");

  return {
    outputDir: outputRoot,
    adapterPath
  };
};
