import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  Expr,
  JsonValue,
  ProofDomainDef,
  ResolvedMachineDef,
  Update,
  ValueType,
  VariableDef
} from "../core/dsl.js";
import { formatActionLabel } from "../core/actionLabels.js";
import { NULL_VALUE } from "../core/proof.js";
import { assertValidMachine } from "../core/validate.js";

const NULL_SYMBOL = "Null";

const tlaString = (value: string): string => JSON.stringify(value);

const assertNever = (value: never): never => {
  throw new Error(`Unhandled value: ${JSON.stringify(value)}`);
};

const indentBlock = (value: string, indent = "  "): string =>
  value
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");

const tlaLiteral = (value: JsonValue): string => {
  if (value === null) {
    return NULL_SYMBOL;
  }

  if (typeof value === "string") {
    return tlaString(value);
  }

  if (typeof value === "number") {
    return String(value);
  }

  if (typeof value === "boolean") {
    return value ? "TRUE" : "FALSE";
  }

  if (Array.isArray(value)) {
    return `{${value.map((item) => tlaLiteral(item)).join(", ")}}`;
  }

  return `[${Object.entries(value)
    .map(([key, nested]) => `${key} |-> ${tlaLiteral(nested)}`)
    .join(", ")}]`;
};

const proofDomainValueToTla = (
  domain: ProofDomainDef,
  value: string,
  options?: { stringifyModelValues?: boolean }
): string =>
  domain.kind === "modelValues" && options?.stringifyModelValues !== true ? value : tlaString(value);

const valueTypeToTla = (valueType: ValueType): string => {
  switch (valueType.kind) {
    case "enum":
      return `{${valueType.values.map((value) => tlaString(value)).join(", ")}}`;
    case "domain":
      return valueType.name;
    case "boolean":
      return "BOOLEAN";
    case "range":
      return `${valueType.min}..${valueType.max}`;
    case "null":
      return `{${NULL_SYMBOL}}`;
    case "option":
      return `${valueTypeToTla(valueType.value)} \\cup {${NULL_SYMBOL}}`;
    case "union":
      return valueType.members.map((member) => valueTypeToTla(member)).join(" \\cup ");
  }

  return assertNever(valueType);
};

const exprToTla = (expr: Expr): string => {
  switch (expr.kind) {
    case "lit":
      return tlaLiteral(expr.value);
    case "param":
      return expr.name;
    case "var":
      return expr.name;
    case "index":
      return `${exprToTla(expr.target)}[${exprToTla(expr.key)}]`;
    case "set":
      return `{${expr.values.map((value) => exprToTla(value)).join(", ")}}`;
    case "and":
      return expr.values.length === 0
        ? "TRUE"
        : expr.values.map((value) => `(${exprToTla(value)})`).join(" /\\ ");
    case "or":
      return expr.values.length === 0
        ? "FALSE"
        : expr.values.map((value) => `(${exprToTla(value)})`).join(" \\/ ");
    case "not":
      return `~(${exprToTla(expr.value)})`;
    case "eq":
      return `${exprToTla(expr.left)} = ${exprToTla(expr.right)}`;
    case "lte":
      return `${exprToTla(expr.left)} <= ${exprToTla(expr.right)}`;
    case "in":
      return `${exprToTla(expr.elem)} \\in ${exprToTla(expr.set)}`;
    case "count":
      return `Cardinality({${expr.binder} \\in ${expr.domain} : ${exprToTla(expr.where)}})`;
    case "forall":
      return `\\A ${expr.binder} \\in ${expr.domain} : ${exprToTla(expr.where)}`;
  }

  return assertNever(expr);
};

const initForVariable = (name: string, variableDef: VariableDef): string => {
  if (variableDef.kind === "scalar") {
    return `  /\\ ${name} = ${exprToTla(variableDef.initial)}`;
  }

  return `  /\\ ${name} = [x \\in ${variableDef.domain} |-> ${exprToTla(variableDef.initial)}]`;
};

const typeOkForVariable = (name: string, variableDef: VariableDef): string => {
  if (variableDef.kind === "scalar") {
    return `  /\\ ${name} \\in ${valueTypeToTla(variableDef.type)}`;
  }

  return `  /\\ ${name} \\in [${variableDef.domain} -> ${valueTypeToTla(variableDef.codomain)}]`;
};

const updateToTla = (update: Update): string => {
  switch (update.kind) {
    case "setVar":
      return `  /\\ ${update.name}' = ${exprToTla(update.value)}`;
    case "setMap":
      return `  /\\ ${update.name}' = [${update.name} EXCEPT ![${exprToTla(update.key)}] = ${exprToTla(update.value)}]`;
  }

  return assertNever(update);
};

const unchangedClause = (machine: ResolvedMachineDef, updates: readonly Update[]): string | null => {
  const changed = new Set(updates.map((update) => update.name));
  const unchanged = Object.keys(machine.variables).filter((name) => !changed.has(name));
  if (unchanged.length === 0) {
    return null;
  }
  return `  /\\ UNCHANGED <<${unchanged.join(", ")}>>`;
};

interface ActionInstance {
  operatorName: string;
  actionLabel: string;
  binding: Record<string, string>;
}

const cartesianBindings = (
  entries: readonly (readonly [string, readonly string[]])[]
): Record<string, string>[] => {
  if (entries.length === 0) {
    return [{}];
  }

  const [[headName, headDomain], ...tail] = entries;
  const tailBindings = cartesianBindings(tail);
  const out: Record<string, string>[] = [];

  for (const value of headDomain) {
    for (const binding of tailBindings) {
      out.push({ ...binding, [headName]: value });
    }
  }

  return out;
};

const actionInstances = (machine: ResolvedMachineDef, actionName: string): readonly ActionInstance[] => {
  const action = machine.actions[actionName];
  const paramNames = Object.keys(action.params);
  if (paramNames.length === 0) {
    return [];
  }

  const bindings = cartesianBindings(
    paramNames.map((paramName) => {
      const domainName = action.params[paramName];
      const domain = machine.domains[domainName];
      if (domain === undefined) {
        throw new Error(`Unknown domain ${domainName}`);
      }
      return [paramName, domain] as const;
    })
  );

  return bindings.map((binding, index) => {
    return {
      operatorName: `Action_${actionName}_${index + 1}`,
      actionLabel: formatActionLabel(machine, actionName, binding),
      binding
    };
  });
};

const withoutKey = (record: Record<string, string>, key: string): Record<string, string> => {
  const out = { ...record };
  delete out[key];
  return out;
};

const substituteExpr = (expr: Expr, binding: Record<string, string>): Expr => {
  switch (expr.kind) {
    case "lit":
    case "var":
      return expr;
    case "param":
      return Object.prototype.hasOwnProperty.call(binding, expr.name) ? { kind: "lit", value: binding[expr.name] } : expr;
    case "index":
      return {
        kind: "index",
        target: substituteExpr(expr.target, binding),
        key: substituteExpr(expr.key, binding)
      };
    case "set":
      return { kind: "set", values: expr.values.map((value) => substituteExpr(value, binding)) };
    case "and":
      return { kind: "and", values: expr.values.map((value) => substituteExpr(value, binding)) };
    case "or":
      return { kind: "or", values: expr.values.map((value) => substituteExpr(value, binding)) };
    case "not":
      return { kind: "not", value: substituteExpr(expr.value, binding) };
    case "eq":
      return {
        kind: "eq",
        left: substituteExpr(expr.left, binding),
        right: substituteExpr(expr.right, binding)
      };
    case "lte":
      return {
        kind: "lte",
        left: substituteExpr(expr.left, binding),
        right: substituteExpr(expr.right, binding)
      };
    case "in":
      return {
        kind: "in",
        elem: substituteExpr(expr.elem, binding),
        set: substituteExpr(expr.set, binding)
      };
    case "count":
      return {
        kind: "count",
        domain: expr.domain,
        binder: expr.binder,
        where: substituteExpr(expr.where, withoutKey(binding, expr.binder))
      };
    case "forall":
      return {
        kind: "forall",
        domain: expr.domain,
        binder: expr.binder,
        where: substituteExpr(expr.where, withoutKey(binding, expr.binder))
      };
  }

  return assertNever(expr);
};

const substituteUpdate = (update: Update, binding: Record<string, string>): Update => {
  switch (update.kind) {
    case "setVar":
      return {
        kind: "setVar",
        name: update.name,
        value: substituteExpr(update.value, binding)
      };
    case "setMap":
      return {
        kind: "setMap",
        name: update.name,
        key: substituteExpr(update.key, binding),
        value: substituteExpr(update.value, binding)
      };
  }

  return assertNever(update);
};

const actionInstanceToTla = (
  machine: ResolvedMachineDef,
  actionName: string,
  instance: ActionInstance
): string => {
  const action = machine.actions[actionName];
  const lines = [
    `${instance.operatorName} ==`,
    `  /\\ ${exprToTla(substituteExpr(action.guard, instance.binding))}`
  ];
  const updates = action.updates.map((update) => substituteUpdate(update, instance.binding));
  lines.push(...updates.map((update) => updateToTla(update)));

  const unchanged = unchangedClause(machine, action.updates);
  if (unchanged !== null) {
    lines.push(unchanged);
  }

  return lines.join("\n");
};

const actionToTla = (machine: ResolvedMachineDef, name: string): string => {
  const action = machine.actions[name];
  const params = Object.keys(action.params);
  const signature = params.length === 0 ? `${name} ==` : `${name}(${params.join(", ")}) ==`;
  const domainChecks = params.map(
    (paramName) => `  /\\ ${paramName} \\in ${action.params[paramName]}`
  );
  const lines = [signature, ...domainChecks, `  /\\ ${exprToTla(action.guard)}`];
  lines.push(...action.updates.map((update) => updateToTla(update)));

  const unchanged = unchangedClause(machine, action.updates);
  if (unchanged !== null) {
    lines.push(unchanged);
  }

  return lines.join("\n");
};

const nextToTla = (machine: ResolvedMachineDef): string =>
  Object.entries(machine.actions)
    .map(([name, action]) => {
      const params = Object.keys(action.params);
      if (params.length === 0) {
        return `  \\/ ${name}`;
      }
      const quantifiers = params
        .map((paramName) => `${paramName} \\in ${action.params[paramName]}`)
        .join(", ");
      return `  \\/ \\E ${quantifiers} : ${name}(${params.join(", ")})`;
    })
    .join("\n");

const equivalenceNextToTla = (machine: ResolvedMachineDef): string =>
  Object.entries(machine.actions)
    .map(([name, action]) => {
      const params = Object.keys(action.params);
      if (params.length === 0) {
        return `  \\/ ${name}`;
      }
      return actionInstances(machine, name)
        .map((instance) => `  \\/ ${instance.operatorName}`)
        .join("\n");
    })
    .join("\n");

const propertyBodies = (machine: ResolvedMachineDef): readonly string[] =>
  Object.entries(machine.properties ?? {}).map(
    ([name, property]) => `${name} ==\n${indentBlock(property.formula)}`
  );

const renderSymmetry = (machine: ResolvedMachineDef): string[] => {
  const domains = machine.resolvedTier.symmetryDomains;
  if (domains.length === 0) {
    return [];
  }

  if (domains.length === 1) {
    return [`Symmetry == Permutations(${domains[0]})`];
  }

  const binders = domains.map((domain, index) => `p${index + 1} \\in Permutations(${domain})`).join(", ");
  const combined = domains.map((_, index) => `p${index + 1}`).join(" @@ ");
  return [`Symmetry ==`, `  {${combined} : ${binders}}`];
};

const cfgValue = (
  domain: ProofDomainDef,
  value: string,
  options?: { stringifyModelValues?: boolean }
): string => proofDomainValueToTla(domain, value, options);

const renderCfgDomains = (
  machine: ResolvedMachineDef,
  options?: { stringifyModelValues?: boolean }
): string[] =>
  Object.entries(machine.domains).map(([name, values]) => {
    const domain = machine.resolvedTier.domains[name];
    return `  ${name} = {${values
      .map((value) => cfgValue(domain, value, options))
      .join(", ")}}`;
  });

export const generateTlaModule = (machine: ResolvedMachineDef): string => {
  assertValidMachine(machine);
  const variables = Object.keys(machine.variables);
  const constantNames = Object.keys(machine.domains);
  const actionBodies = Object.keys(machine.actions).map((name) => actionToTla(machine, name));
  const actionInstanceBodies = Object.keys(machine.actions).flatMap((name) =>
    actionInstances(machine, name).map((instance) => actionInstanceToTla(machine, name, instance))
  );
  const invariantBodies = Object.entries(machine.invariants).map(
    ([name, invariant]) => `${name} ==\n  ${exprToTla(invariant.formula)}`
  );
  const symmetryBody = renderSymmetry(machine);
  const rawPropertyBodies = propertyBodies(machine);

  return [
    `---- MODULE ${machine.moduleName} ----`,
    "EXTENDS FiniteSets, Integers, TLC",
    "",
    "\\* Generated. Treat as a build artifact.",
    `${NULL_SYMBOL} == ${tlaString(NULL_VALUE)}`,
    "",
    constantNames.length === 0 ? null : `CONSTANTS ${constantNames.join(", ")}`,
    "",
    symmetryBody.length === 0 ? null : symmetryBody.join("\n"),
    symmetryBody.length === 0 ? null : "",
    `VARIABLES ${variables.join(", ")}`,
    "",
    `vars == <<${variables.join(", ")}>>`,
    "",
    "TypeOK ==",
    ...Object.entries(machine.variables).map(([name, variableDef]) => typeOkForVariable(name, variableDef)),
    "",
    ...invariantBodies,
    invariantBodies.length === 0 ? null : "",
    ...rawPropertyBodies,
    rawPropertyBodies.length === 0 ? null : "",
    ...actionBodies,
    actionInstanceBodies.length === 0 ? null : "",
    ...actionInstanceBodies,
    "",
    "Init ==",
    ...Object.entries(machine.variables).map(([name, variableDef]) => initForVariable(name, variableDef)),
    "",
    "Next ==",
    nextToTla(machine),
    "",
    "EquivalenceNext ==",
    equivalenceNextToTla(machine),
    "",
    "Spec == Init /\\ [][Next]_vars",
    "EquivalenceSpec == Init /\\ [][EquivalenceNext]_vars",
    "",
    "===="
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
};

export const generateCfg = (
  machine: ResolvedMachineDef,
  options?: { includeSymmetry?: boolean; specification?: string; stringifyModelValues?: boolean }
): string => {
  assertValidMachine(machine);
  const includeSymmetry = options?.includeSymmetry ?? true;
  const invariantNames = ["TypeOK", ...machine.resolvedTier.invariants];
  const domainLines = renderCfgDomains(machine, {
    stringifyModelValues: options?.stringifyModelValues
  });
  const lines: string[] = [`SPECIFICATION ${options?.specification ?? "Spec"}`];

  if (domainLines.length > 0) {
    lines.push("", "CONSTANTS", ...domainLines);
  }

  if (invariantNames.length > 0) {
    lines.push("", "INVARIANT", ...invariantNames.map((name) => `  ${name}`));
  }

  if (machine.resolvedTier.properties.length > 0) {
    lines.push(
      "",
      "PROPERTY",
      ...machine.resolvedTier.properties.map((name) => `  ${name}`)
    );
  }

  if (includeSymmetry && machine.resolvedTier.symmetryDomains.length > 0) {
    lines.push("", "SYMMETRY Symmetry");
  }

  if (!machine.resolvedTier.checks.deadlock) {
    lines.push("", "CHECK_DEADLOCK FALSE");
  }

  return lines.join("\n");
};

export interface GeneratedPaths {
  outputDir: string;
  tlaPath: string;
  cfgPath: string;
  actionLabelsPath: string;
}

export const writeGeneratedMachine = async (
  machine: ResolvedMachineDef,
  outputRoot: string
): Promise<GeneratedPaths> => {
  const outputDir = join(outputRoot, machine.moduleName, machine.resolvedTier.name);
  await mkdir(outputDir, { recursive: true });

  const tlaPath = join(outputDir, `${machine.moduleName}.tla`);
  const cfgPath = join(outputDir, `${machine.moduleName}.cfg`);
  const actionLabelsPath = join(outputDir, `${machine.moduleName}.action-labels.json`);
  const actionLabels = Object.fromEntries(
    Object.keys(machine.actions).flatMap((name) =>
      actionInstances(machine, name).map((instance) => [instance.operatorName, instance.actionLabel] as const)
    )
  );

  await writeFile(tlaPath, generateTlaModule(machine), "utf8");
  await writeFile(cfgPath, generateCfg(machine), "utf8");
  await writeFile(actionLabelsPath, JSON.stringify(actionLabels, null, 2), "utf8");

  return { outputDir, tlaPath, cfgPath, actionLabelsPath };
};
