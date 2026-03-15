import type {
  Expr,
  MachineDef,
  RowPredicateExpr,
  RowValueExpr,
  StorageConstraintDef,
  Update,
  ValueType
} from "./dsl.js";
import {
  GENERATED_ACTION_PREFIX,
  NULL_SENTINEL,
  RESERVED_DOMAIN_VALUE,
  isReservedCompilerName,
  isValidIdentifier
} from "./encoding.js";

export interface ValidationIssue {
  code: string;
  path: string;
  message: string;
}

interface Scope {
  readonly actionParams: Readonly<Record<string, string>>;
  readonly binders: Readonly<Record<string, string>>;
}

interface DomainReference {
  readonly path: string;
  readonly name: string;
}

const MAX_PROOF_DOMAIN_SIZE = 100;
const MAX_ACTION_PARAM_COUNT = 4;
const MAX_EQUIVALENCE_STATES = 100_000;
const MAX_EQUIVALENCE_BRANCHING = 10_000;
const VALID_ADAPTER_KEY_SQL_TYPES = new Set(["text", "uuid", "bigint"]);

const compareIssues = (left: ValidationIssue, right: ValidationIssue): number =>
  left.path.localeCompare(right.path) ||
  left.code.localeCompare(right.code) ||
  left.message.localeCompare(right.message);

const pushIssue = (
  issues: ValidationIssue[],
  code: string,
  path: string,
  message: string
): void => {
  issues.push({ code, path, message });
};

const hasOwn = (record: Readonly<Record<string, string>>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key);

const validateIdentifierName = (
  value: string,
  path: string,
  issues: ValidationIssue[],
  options?: { allowGeneratedPrefix?: boolean }
): void => {
  if (!isValidIdentifier(value)) {
    pushIssue(
      issues,
      "invalid-identifier",
      path,
      `Expected a TLA-safe identifier, received ${JSON.stringify(value)}`
    );
    return;
  }

  if (
    isReservedCompilerName(value) &&
    !(options?.allowGeneratedPrefix === true && value.startsWith(GENERATED_ACTION_PREFIX))
  ) {
    pushIssue(
      issues,
      "reserved-name",
      path,
      `Identifier ${JSON.stringify(value)} is reserved by the compiler`
    );
  }
};

const validateStringAtom = (value: string, path: string, issues: ValidationIssue[]): void => {
  if (value === NULL_SENTINEL) {
    pushIssue(
      issues,
      "reserved-string-literal",
      path,
      `String ${JSON.stringify(NULL_SENTINEL)} is reserved for internal null encoding`
    );
  }
};

const validatePrimitiveLiteral = (value: unknown, path: string, issues: ValidationIssue[]): void => {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    if (typeof value === "string") {
      validateStringAtom(value, path, issues);
    }
    return;
  }

  pushIssue(
    issues,
    "unsupported-composite-literal",
    path,
    "Machine literals must be primitive values; arrays and objects are not allowed"
  );
};

const isPrimitiveLiteralExpr = (expr: Expr): boolean =>
  expr.kind === "lit" &&
  (expr.value === null ||
    typeof expr.value === "string" ||
    typeof expr.value === "number" ||
    typeof expr.value === "boolean");

const resolveScopedDomain = (scope: Scope, name: string): string | null => {
  if (hasOwn(scope.binders, name)) {
    return scope.binders[name] as string;
  }
  if (hasOwn(scope.actionParams, name)) {
    return scope.actionParams[name] as string;
  }
  return null;
};

const validateDomainReference = (
  domainName: string,
  path: string,
  issues: ValidationIssue[],
  domainReferences: DomainReference[]
): void => {
  validateIdentifierName(domainName, path, issues);
  domainReferences.push({ name: domainName, path });
};

const validateValueType = (
  type: ValueType,
  path: string,
  issues: ValidationIssue[],
  domainReferences: DomainReference[]
): void => {
  switch (type.kind) {
    case "enum": {
      if (type.values.length === 0) {
        pushIssue(issues, "empty-enum", path, "Enum types must contain at least one value");
      }
      const seen = new Set<string>();
      for (const [index, value] of type.values.entries()) {
        validateStringAtom(value, `${path}.values[${index}]`, issues);
        if (seen.has(value)) {
          pushIssue(
            issues,
            "duplicate-enum-value",
            `${path}.values[${index}]`,
            `Duplicate enum value ${JSON.stringify(value)}`
          );
        }
        seen.add(value);
      }
      return;
    }
    case "domain":
      validateDomainReference(type.name, `${path}.name`, issues, domainReferences);
      return;
    case "boolean":
    case "null":
      return;
    case "range":
      if (!Number.isInteger(type.min) || !Number.isInteger(type.max) || type.max < type.min) {
        pushIssue(
          issues,
          "invalid-range",
          path,
          `Range bounds must be integers with min <= max, received ${type.min}..${type.max}`
        );
      }
      return;
    case "option":
      validateValueType(type.value, `${path}.value`, issues, domainReferences);
      return;
    case "union":
      if (type.members.length === 0) {
        pushIssue(issues, "empty-union", path, "Union types must contain at least one member");
      }
      for (const [index, member] of type.members.entries()) {
        validateValueType(member, `${path}.members[${index}]`, issues, domainReferences);
      }
      return;
  }
};

const validateMapKeyExpr = (
  expr: Expr,
  mapDomain: string,
  path: string,
  scope: Scope,
  machine: MachineDef,
  issues: ValidationIssue[]
): void => {
  if (expr.kind === "param") {
    const domainName = resolveScopedDomain(scope, expr.name);
    if (domainName !== null && domainName !== mapDomain) {
      pushIssue(
        issues,
        "map-key-domain-mismatch",
        path,
        `Expected key domain ${mapDomain} but ${expr.name} ranges over ${domainName}`
      );
    }
    return;
  }

  if (expr.kind === "lit") {
    if (typeof expr.value !== "string") {
      pushIssue(
        issues,
        "map-key-literal-type",
        path,
        "Map keys must be string literals or in-scope domain parameters"
      );
      return;
    }

    for (const [tierName, tier] of Object.entries(machine.proof.tiers)) {
      const domain = tier.domains[mapDomain];
      if (domain === undefined) {
        continue;
      }

      const values =
        domain.kind === "modelValues"
          ? Array.from({ length: domain.size }, (_, index) => `${domain.prefix}${index + 1}`)
          : domain.kind === "ids"
            ? Array.from({ length: domain.size }, (_, index) => `${domain.prefix}${index + 1}`)
            : domain.values;

      if (!values.includes(expr.value)) {
        pushIssue(
          issues,
          "map-key-out-of-domain",
          path,
          `Literal key ${JSON.stringify(expr.value)} is not in domain ${mapDomain} for tier ${tierName}`
        );
      }
    }
  }
};

const validateExpr = (
  expr: Expr,
  path: string,
  scope: Scope,
  machine: MachineDef,
  issues: ValidationIssue[],
  domainReferences: DomainReference[]
): void => {
  switch (expr.kind) {
    case "lit":
      validatePrimitiveLiteral(expr.value, `${path}.value`, issues);
      return;
    case "param":
      if (resolveScopedDomain(scope, expr.name) === null) {
        pushIssue(
          issues,
          "unknown-param",
          `${path}.name`,
          `Unknown parameter or binder ${JSON.stringify(expr.name)}`
        );
      }
      return;
    case "var":
      if (machine.variables[expr.name] === undefined) {
        pushIssue(
          issues,
          "unknown-variable",
          `${path}.name`,
          `Unknown machine variable ${JSON.stringify(expr.name)}`
        );
      }
      return;
    case "index": {
      validateExpr(expr.target, `${path}.target`, scope, machine, issues, domainReferences);
      validateExpr(expr.key, `${path}.key`, scope, machine, issues, domainReferences);
      if (expr.target.kind !== "var") {
        pushIssue(
          issues,
          "invalid-index-target",
          `${path}.target`,
          "Index targets must be direct references to declared map variables"
        );
        return;
      }

      const variableDef = machine.variables[expr.target.name];
      if (variableDef === undefined) {
        return;
      }
      if (variableDef.kind !== "map") {
        pushIssue(
          issues,
          "invalid-index-target",
          `${path}.target`,
          `Variable ${expr.target.name} is scalar and cannot be indexed`
        );
        return;
      }

      validateMapKeyExpr(expr.key, variableDef.domain, `${path}.key`, scope, machine, issues);
      return;
    }
    case "set":
    case "and":
    case "or":
      for (const [index, value] of expr.values.entries()) {
        validateExpr(value, `${path}.values[${index}]`, scope, machine, issues, domainReferences);
      }
      return;
    case "not":
      validateExpr(expr.value, `${path}.value`, scope, machine, issues, domainReferences);
      return;
    case "eq":
    case "lte":
      validateExpr(expr.left, `${path}.left`, scope, machine, issues, domainReferences);
      validateExpr(expr.right, `${path}.right`, scope, machine, issues, domainReferences);
      return;
    case "in":
      validateExpr(expr.elem, `${path}.elem`, scope, machine, issues, domainReferences);
      validateExpr(expr.set, `${path}.set`, scope, machine, issues, domainReferences);
      return;
    case "count":
    case "forall": {
      validateDomainReference(expr.domain, `${path}.domain`, issues, domainReferences);
      validateIdentifierName(expr.binder, `${path}.binder`, issues);
      if (machine.variables[expr.binder] !== undefined || hasOwn(scope.actionParams, expr.binder) || hasOwn(scope.binders, expr.binder)) {
        pushIssue(
          issues,
          "binder-shadowing",
          `${path}.binder`,
          `Binder ${JSON.stringify(expr.binder)} may not shadow an existing variable, action param, or binder`
        );
      }
      validateExpr(
        expr.where,
        `${path}.where`,
        {
          actionParams: scope.actionParams,
          binders: { ...scope.binders, [expr.binder]: expr.domain }
        },
        machine,
        issues,
        domainReferences
      );
      return;
    }
  }
};

const validateUpdate = (
  update: Update,
  path: string,
  scope: Scope,
  machine: MachineDef,
  issues: ValidationIssue[],
  domainReferences: DomainReference[]
): void => {
  const variableDef = machine.variables[update.name];
  if (variableDef === undefined) {
    pushIssue(
      issues,
      "invalid-update-target",
      `${path}.name`,
      `Unknown update target ${JSON.stringify(update.name)}`
    );
    if (update.kind === "setVar") {
      validateExpr(update.value, `${path}.value`, scope, machine, issues, domainReferences);
    } else {
      validateExpr(update.key, `${path}.key`, scope, machine, issues, domainReferences);
      validateExpr(update.value, `${path}.value`, scope, machine, issues, domainReferences);
    }
    return;
  }

  if (update.kind === "setVar") {
    if (variableDef.kind !== "scalar") {
      pushIssue(
        issues,
        "invalid-update-kind",
        path,
        `setVar may only target scalar variables; ${update.name} is a map`
      );
    }
    validateExpr(update.value, `${path}.value`, scope, machine, issues, domainReferences);
    return;
  }

  if (variableDef.kind !== "map") {
    pushIssue(
      issues,
      "invalid-update-kind",
      path,
      `setMap may only target map variables; ${update.name} is scalar`
    );
    validateExpr(update.key, `${path}.key`, scope, machine, issues, domainReferences);
    validateExpr(update.value, `${path}.value`, scope, machine, issues, domainReferences);
    return;
  }

  validateExpr(update.key, `${path}.key`, scope, machine, issues, domainReferences);
  validateExpr(update.value, `${path}.value`, scope, machine, issues, domainReferences);
  validateMapKeyExpr(update.key, variableDef.domain, `${path}.key`, scope, machine, issues);
};

const validateRowValueExpr = (
  expr: RowValueExpr,
  path: string,
  issues: ValidationIssue[],
  ownedColumns: readonly string[] | undefined
): void => {
  if (expr.kind === "pgColumn") {
    if (expr.name.length === 0) {
      pushIssue(issues, "empty-storage-column", `${path}.name`, "Storage column names may not be empty");
    }
    if (ownedColumns !== undefined && !ownedColumns.includes(expr.name)) {
      pushIssue(
        issues,
        "storage-column-not-owned",
        `${path}.name`,
        `Storage column ${JSON.stringify(expr.name)} is not declared in metadata.ownedColumns`
      );
    }
    return;
  }

};

const validateRowPredicate = (
  predicate: RowPredicateExpr,
  path: string,
  issues: ValidationIssue[],
  ownedColumns: readonly string[] | undefined
): void => {
  switch (predicate.kind) {
    case "pgEq":
      validateRowValueExpr(predicate.left, `${path}.left`, issues, ownedColumns);
      validateRowValueExpr(predicate.right, `${path}.right`, issues, ownedColumns);
      if (
        (predicate.left.kind === "pgLiteral" && predicate.left.value === null) ||
        (predicate.right.kind === "pgLiteral" && predicate.right.value === null)
      ) {
        pushIssue(
          issues,
          "pg-eq-null",
          path,
          "Use isNull()/isNotNull() instead of eq(..., null) in storage predicates"
        );
      }
      return;
    case "pgInSet":
      validateRowValueExpr(predicate.target, `${path}.target`, issues, ownedColumns);
      if (predicate.values.length === 0) {
        pushIssue(issues, "empty-pg-in-set", path, "pgInSet() requires at least one literal value");
      }
      for (const [index, value] of predicate.values.entries()) {
        if (value === null) {
          pushIssue(
            issues,
            "null-pg-in-set",
            `${path}.values[${index}]`,
            "pgInSet() may not contain NULL values"
          );
        }
      }
      return;
    case "pgAnd":
    case "pgOr":
      for (const [index, value] of predicate.values.entries()) {
        validateRowPredicate(value, `${path}.values[${index}]`, issues, ownedColumns);
      }
      return;
    case "pgNot":
      validateRowPredicate(predicate.value, `${path}.value`, issues, ownedColumns);
      return;
    case "pgIsNull":
    case "pgIsNotNull":
      validateRowValueExpr(predicate.value, `${path}.value`, issues, ownedColumns);
      return;
  }
};

const validateStorageConstraint = (
  constraint: StorageConstraintDef,
  path: string,
  machine: MachineDef,
  issues: ValidationIssue[]
): void => {
  if (constraint.name.length === 0) {
    pushIssue(issues, "empty-storage-name", `${path}.name`, "Storage constraint names may not be empty");
  }
  if (constraint.schema.length === 0) {
    pushIssue(issues, "empty-storage-schema", `${path}.schema`, "Storage schema names may not be empty");
  }
  if (constraint.table.length === 0) {
    pushIssue(issues, "empty-storage-table", `${path}.table`, "Storage table names may not be empty");
  }

  const ownedTables = machine.metadata?.ownedTables;
  if (ownedTables !== undefined && !ownedTables.includes(constraint.table)) {
    pushIssue(
      issues,
      "storage-unowned-table",
      `${path}.table`,
      `Storage constraint targets unowned table ${JSON.stringify(constraint.table)}`
    );
  }

  if (
    constraint.backsInvariant !== undefined &&
    machine.invariants[constraint.backsInvariant] === undefined
  ) {
    pushIssue(
      issues,
      "storage-unknown-invariant",
      `${path}.backsInvariant`,
      `Unknown backing invariant ${JSON.stringify(constraint.backsInvariant)}`
    );
  }

  const ownedColumns = machine.metadata?.ownedColumns?.[constraint.table];

  if (constraint.kind === "pgUniqueWhere") {
    if (constraint.columns.length === 0) {
      pushIssue(
        issues,
        "empty-unique-columns",
        `${path}.columns`,
        "Partial unique indexes must declare at least one indexed column"
      );
    }

    const seenColumns = new Set<string>();
    for (const [index, column] of constraint.columns.entries()) {
      if (column.length === 0) {
        pushIssue(
          issues,
          "empty-storage-column",
          `${path}.columns[${index}]`,
          "Storage column names may not be empty"
        );
      }
      if (seenColumns.has(column)) {
        pushIssue(
          issues,
          "duplicate-storage-column",
          `${path}.columns[${index}]`,
          `Duplicate indexed column ${JSON.stringify(column)}`
        );
      }
      seenColumns.add(column);
      if (ownedColumns !== undefined && !ownedColumns.includes(column)) {
        pushIssue(
          issues,
          "storage-column-not-owned",
          `${path}.columns[${index}]`,
          `Indexed column ${JSON.stringify(column)} is not declared in metadata.ownedColumns`
        );
      }
    }

    validateRowPredicate(constraint.where, `${path}.where`, issues, ownedColumns);
    return;
  }

  validateRowPredicate(constraint.predicate, `${path}.predicate`, issues, ownedColumns);
};

const validateTopLevel = (machine: MachineDef, issues: ValidationIssue[]): void => {
  if (machine.version !== 2) {
    pushIssue(
      issues,
      "invalid-version",
      "version",
      `Expected machine version 2, received ${JSON.stringify(machine.version)}`
    );
  }

  validateIdentifierName(machine.moduleName, "moduleName", issues);

  if (machine.proof.tiers[machine.proof.defaultTier] === undefined) {
    pushIssue(
      issues,
      "missing-default-tier",
      "proof.defaultTier",
      `Default tier ${JSON.stringify(machine.proof.defaultTier)} is not declared`
    );
  }
};

const validateTierDomains = (
  machine: MachineDef,
  issues: ValidationIssue[],
  domainReferences: readonly DomainReference[],
  userStringAtoms: readonly string[]
): void => {
  const referencedDomainNames = new Set(domainReferences.map((reference) => reference.name));
  const knownInvariantNames = new Set(Object.keys(machine.invariants));
  const knownPropertyNames = new Set(Object.keys(machine.properties ?? {}));

  for (const reference of domainReferences) {
    for (const [tierName, tier] of Object.entries(machine.proof.tiers)) {
      if (tier.domains[reference.name] === undefined) {
        pushIssue(
          issues,
          "tier-missing-domain",
          `proof.tiers.${tierName}.domains.${reference.name}`,
          `Tier ${tierName} is missing domain ${JSON.stringify(reference.name)} referenced at ${reference.path}`
        );
      }
    }
  }

  for (const [tierName, tier] of Object.entries(machine.proof.tiers)) {
    validateIdentifierName(tierName, `proof.tiers.${tierName}`, issues);
    const renderedValuesByDomain = new Map<string, readonly string[]>();
    const seenRenderedValues = new Map<string, string>();

    for (const [domainName, domain] of Object.entries(tier.domains)) {
      validateIdentifierName(domainName, `proof.tiers.${tierName}.domains.${domainName}`, issues);
      const values =
        domain.kind === "modelValues"
          ? Array.from({ length: domain.size }, (_, index) => `${domain.prefix}${index + 1}`)
          : domain.kind === "ids"
            ? Array.from({ length: domain.size }, (_, index) => `${domain.prefix}${index + 1}`)
            : [...domain.values];

      if (domain.kind === "modelValues" || domain.kind === "ids") {
        validateIdentifierName(
          domain.prefix,
          `proof.tiers.${tierName}.domains.${domainName}.prefix`,
          issues
        );
        if (domain.size > MAX_PROOF_DOMAIN_SIZE) {
          pushIssue(
            issues,
            "domain-size-cap-exceeded",
            `proof.tiers.${tierName}.domains.${domainName}.size`,
            `Proof domain ${domainName} in tier ${tierName} exceeds the hard size cap of ${MAX_PROOF_DOMAIN_SIZE}`
          );
        }
        if (domain.size < 1) {
          pushIssue(
            issues,
            "empty-proof-domain",
            `proof.tiers.${tierName}.domains.${domainName}.size`,
            `Domain ${domainName} in tier ${tierName} must have size >= 1`
          );
        }
      } else {
        if (domain.values.length > MAX_PROOF_DOMAIN_SIZE) {
          pushIssue(
            issues,
            "domain-size-cap-exceeded",
            `proof.tiers.${tierName}.domains.${domainName}.values`,
            `Proof domain ${domainName} in tier ${tierName} exceeds the hard size cap of ${MAX_PROOF_DOMAIN_SIZE}`
          );
        }
        if (domain.values.length === 0) {
          pushIssue(
            issues,
            "empty-proof-domain",
            `proof.tiers.${tierName}.domains.${domainName}.values`,
            `Explicit domain ${domainName} in tier ${tierName} must contain at least one value`
          );
        }

        const seen = new Set<string>();
        for (const [index, value] of domain.values.entries()) {
          validateStringAtom(
            value,
            `proof.tiers.${tierName}.domains.${domainName}.values[${index}]`,
            issues
          );
          if (seen.has(value)) {
            pushIssue(
              issues,
              "duplicate-domain-value",
              `proof.tiers.${tierName}.domains.${domainName}.values[${index}]`,
              `Duplicate explicit domain value ${JSON.stringify(value)}`
            );
          }
          seen.add(value);
        }
      }

      renderedValuesByDomain.set(domainName, values);
      for (const value of values) {
        if (value === RESERVED_DOMAIN_VALUE) {
          pushIssue(
            issues,
            "reserved-domain-value",
            `proof.tiers.${tierName}.domains.${domainName}`,
            `Tier ${tierName} may not render reserved value ${JSON.stringify(RESERVED_DOMAIN_VALUE)}`
          );
        }
        const owner = seenRenderedValues.get(value);
        if (owner !== undefined && owner !== domainName) {
          pushIssue(
            issues,
            "duplicate-rendered-domain-value",
            `proof.tiers.${tierName}.domains.${domainName}`,
            `Rendered proof value ${JSON.stringify(value)} collides across domains ${owner} and ${domainName}`
          );
        }
        seenRenderedValues.set(value, domainName);

        if (domain.kind === "modelValues" && userStringAtoms.includes(value)) {
          pushIssue(
            issues,
            "model-value-string-collision",
            `proof.tiers.${tierName}.domains.${domainName}`,
            `Rendered model value ${JSON.stringify(value)} collides with a user string literal`
          );
        }
      }
    }

    for (const domainName of Object.keys(tier.domains)) {
      if (!referencedDomainNames.has(domainName)) {
        pushIssue(
          issues,
          "unused-tier-domain",
          `proof.tiers.${tierName}.domains.${domainName}`,
          `Tier ${tierName} declares unused domain ${JSON.stringify(domainName)}`
        );
      }
    }

    const graphEquivalence = tier.graphEquivalence ?? true;
    if (
      graphEquivalence &&
      tier.budgets?.maxEstimatedStates !== undefined &&
      tier.budgets.maxEstimatedStates > MAX_EQUIVALENCE_STATES
    ) {
      pushIssue(
        issues,
        "equivalence-budget-cap-exceeded",
        `proof.tiers.${tierName}.budgets.maxEstimatedStates`,
        `Graph-equivalence tiers may not declare maxEstimatedStates above ${MAX_EQUIVALENCE_STATES}`
      );
    }
    if (
      graphEquivalence &&
      tier.budgets?.maxEstimatedBranching !== undefined &&
      tier.budgets.maxEstimatedBranching > MAX_EQUIVALENCE_BRANCHING
    ) {
      pushIssue(
        issues,
        "equivalence-branching-budget-cap-exceeded",
        `proof.tiers.${tierName}.budgets.maxEstimatedBranching`,
        `Graph-equivalence tiers may not declare maxEstimatedBranching above ${MAX_EQUIVALENCE_BRANCHING}`
      );
    }

    for (const invariantName of tier.invariants ?? Object.keys(machine.invariants)) {
      if (!knownInvariantNames.has(invariantName)) {
        pushIssue(
          issues,
          "unknown-tier-invariant",
          `proof.tiers.${tierName}.invariants`,
          `Tier ${tierName} references unknown invariant ${JSON.stringify(invariantName)}`
        );
      }
    }

    for (const propertyName of tier.properties ?? []) {
      if (!knownPropertyNames.has(propertyName)) {
        pushIssue(
          issues,
          "unknown-tier-property",
          `proof.tiers.${tierName}.properties`,
          `Tier ${tierName} references unknown property ${JSON.stringify(propertyName)}`
        );
      }
    }

    const hasSymmetry = Object.values(tier.domains).some(
      (domain) => domain.kind === "modelValues" && domain.symmetry === true
    );
    if (hasSymmetry && (tier.properties?.length ?? 0) > 0) {
      pushIssue(
        issues,
        "symmetry-temporal-conflict",
        `proof.tiers.${tierName}.properties`,
        `Tier ${tierName} cannot combine symmetry reduction with temporal properties`
      );
    }
  }
};

const validateRuntimeAdapterQuantifiers = (
  expr: Expr,
  path: string,
  rowDomain: string,
  issues: ValidationIssue[]
): void => {
  switch (expr.kind) {
    case "lit":
    case "param":
    case "var":
      return;
    case "index":
      validateRuntimeAdapterQuantifiers(expr.target, `${path}.target`, rowDomain, issues);
      validateRuntimeAdapterQuantifiers(expr.key, `${path}.key`, rowDomain, issues);
      return;
    case "set":
    case "and":
    case "or":
      for (const [index, value] of expr.values.entries()) {
        validateRuntimeAdapterQuantifiers(value, `${path}.values[${index}]`, rowDomain, issues);
      }
      return;
    case "not":
      validateRuntimeAdapterQuantifiers(expr.value, `${path}.value`, rowDomain, issues);
      return;
    case "eq":
    case "lte":
      validateRuntimeAdapterQuantifiers(expr.left, `${path}.left`, rowDomain, issues);
      validateRuntimeAdapterQuantifiers(expr.right, `${path}.right`, rowDomain, issues);
      return;
    case "in":
      validateRuntimeAdapterQuantifiers(expr.elem, `${path}.elem`, rowDomain, issues);
      validateRuntimeAdapterQuantifiers(expr.set, `${path}.set`, rowDomain, issues);
      return;
    case "count":
    case "forall":
      if (expr.domain !== rowDomain) {
        pushIssue(
          issues,
          "adapter-unsupported-quantifier-domain",
          `${path}.domain`,
          `Runtime adapter quantifiers may only range over ${JSON.stringify(rowDomain)}`
        );
      }
      validateRuntimeAdapterQuantifiers(expr.where, `${path}.where`, rowDomain, issues);
      return;
  }
};

const validateRuntimeAdapter = (machine: MachineDef, issues: ValidationIssue[]): void => {
  const adapter = machine.metadata?.runtimeAdapter;
  if (adapter === undefined) {
    return;
  }

  const ownedTables = machine.metadata?.ownedTables ?? [];
  if (!ownedTables.includes(adapter.table)) {
    pushIssue(
      issues,
      "adapter-table-not-owned",
      "metadata.runtimeAdapter.table",
      `Runtime adapter table ${JSON.stringify(adapter.table)} must be declared in metadata.ownedTables`
    );
  }
  if (ownedTables.length !== 1) {
    pushIssue(
      issues,
      "adapter-single-table-required",
      "metadata.ownedTables",
      "Runtime adapter generation currently requires exactly one owned table"
    );
  }

  const ownedColumns = machine.metadata?.ownedColumns?.[adapter.table];
  if (ownedColumns === undefined) {
    pushIssue(
      issues,
      "adapter-variable-column-missing",
      `metadata.ownedColumns.${adapter.table}`,
      `Owned columns for runtime adapter table ${JSON.stringify(adapter.table)} must be declared`
    );
  }

  if (adapter.keyColumn.length === 0) {
    pushIssue(
      issues,
      "adapter-invalid-key-column",
      "metadata.runtimeAdapter.keyColumn",
      "Runtime adapter keyColumn may not be empty"
    );
  }
  if (!VALID_ADAPTER_KEY_SQL_TYPES.has(adapter.keySqlType)) {
    pushIssue(
      issues,
      "adapter-invalid-key-sql-type",
      "metadata.runtimeAdapter.keySqlType",
      `Runtime adapter keySqlType ${JSON.stringify(adapter.keySqlType)} is not supported`
    );
  }

  for (const [variableName, variable] of Object.entries(machine.variables)) {
    if (variable.kind !== "map") {
      pushIssue(
        issues,
        "adapter-map-only-machine-required",
        `variables.${variableName}`,
        "Runtime adapter generation currently supports map-only machines"
      );
      continue;
    }
    if (variable.domain !== adapter.rowDomain) {
      pushIssue(
        issues,
        "adapter-row-domain-mismatch",
        `variables.${variableName}.domain`,
        `Runtime adapter variables must all use row domain ${JSON.stringify(adapter.rowDomain)}`
      );
    }
    if (ownedColumns !== undefined && !ownedColumns.includes(variableName)) {
      pushIssue(
        issues,
        "adapter-variable-column-missing",
        `variables.${variableName}`,
        `Variable ${JSON.stringify(variableName)} must map to a same-named owned column`
      );
    }
    if (!isPrimitiveLiteralExpr(variable.initial)) {
      pushIssue(
        issues,
        "adapter-nonliteral-initial",
        `variables.${variableName}.initial`,
        "Runtime adapter map variables must use primitive literal initial values"
      );
    }
  }

  for (const [actionName, action] of Object.entries(machine.actions)) {
    validateRuntimeAdapterQuantifiers(
      action.guard,
      `actions.${actionName}.guard`,
      adapter.rowDomain,
      issues
    );
    for (const [updateIndex, update] of action.updates.entries()) {
      if (update.kind === "setVar") {
        validateRuntimeAdapterQuantifiers(
          update.value,
          `actions.${actionName}.updates[${updateIndex}].value`,
          adapter.rowDomain,
          issues
        );
        continue;
      }
      validateRuntimeAdapterQuantifiers(
        update.key,
        `actions.${actionName}.updates[${updateIndex}].key`,
        adapter.rowDomain,
        issues
      );
      validateRuntimeAdapterQuantifiers(
        update.value,
        `actions.${actionName}.updates[${updateIndex}].value`,
        adapter.rowDomain,
        issues
      );
    }
  }
};

export const validateMachine = (machine: MachineDef): readonly ValidationIssue[] => {
  const issues: ValidationIssue[] = [];
  const domainReferences: DomainReference[] = [];

  validateTopLevel(machine, issues);

  for (const [name, variable] of Object.entries(machine.variables)) {
    validateIdentifierName(name, `variables.${name}`, issues);
    if (variable.kind === "scalar") {
      validateValueType(variable.type, `variables.${name}.type`, issues, domainReferences);
      validateExpr(
        variable.initial,
        `variables.${name}.initial`,
        { actionParams: {}, binders: {} },
        machine,
        issues,
        domainReferences
      );
      continue;
    }

    validateDomainReference(variable.domain, `variables.${name}.domain`, issues, domainReferences);
    validateValueType(variable.codomain, `variables.${name}.codomain`, issues, domainReferences);
    validateExpr(
      variable.initial,
      `variables.${name}.initial`,
      { actionParams: {}, binders: {} },
      machine,
      issues,
      domainReferences
    );
  }

  for (const [name, action] of Object.entries(machine.actions)) {
    validateIdentifierName(name, `actions.${name}`, issues);
    const actionParams: Record<string, string> = {};
    const actionParamEntries = Object.entries(action.params);

    if (actionParamEntries.length > MAX_ACTION_PARAM_COUNT) {
      pushIssue(
        issues,
        "action-param-cap-exceeded",
        `actions.${name}.params`,
        `Action ${name} exceeds the hard parameter cap of ${MAX_ACTION_PARAM_COUNT}`
      );
    }

    for (const [paramName, domainName] of actionParamEntries) {
      validateIdentifierName(paramName, `actions.${name}.params.${paramName}`, issues);
      validateDomainReference(
        domainName,
        `actions.${name}.params.${paramName}`,
        issues,
        domainReferences
      );
      if (machine.variables[paramName] !== undefined) {
        pushIssue(
          issues,
          "param-shadowing-variable",
          `actions.${name}.params.${paramName}`,
          `Action parameter ${JSON.stringify(paramName)} may not shadow a machine variable`
        );
      }
      actionParams[paramName] = domainName;
    }

    const actionScope: Scope = { actionParams, binders: {} };

    validateExpr(action.guard, `actions.${name}.guard`, actionScope, machine, issues, domainReferences);

    const seenUpdates = new Set<string>();
    for (const [index, update] of action.updates.entries()) {
      if (seenUpdates.has(update.name)) {
        pushIssue(
          issues,
          "duplicate-update-target",
          `actions.${name}.updates[${index}].name`,
          `Action ${name} writes ${JSON.stringify(update.name)} more than once`
        );
      }
      seenUpdates.add(update.name);
      validateUpdate(
        update,
        `actions.${name}.updates[${index}]`,
        actionScope,
        machine,
        issues,
        domainReferences
      );
    }
  }

  for (const [name, invariant] of Object.entries(machine.invariants)) {
    validateIdentifierName(name, `invariants.${name}`, issues);
    validateExpr(
      invariant.formula,
      `invariants.${name}.formula`,
      { actionParams: {}, binders: {} },
      machine,
      issues,
      domainReferences
    );
  }

  for (const [name] of Object.entries(machine.properties ?? {})) {
    validateIdentifierName(name, `properties.${name}`, issues);
  }

  if (machine.metadata?.storageConstraints !== undefined) {
    const seenConstraints = new Set<string>();
    for (const [index, constraint] of machine.metadata.storageConstraints.entries()) {
      const key = `${constraint.schema}.${constraint.table}.${constraint.name}`;
      if (seenConstraints.has(key)) {
        pushIssue(
          issues,
          "duplicate-storage-constraint",
          `metadata.storageConstraints[${index}].name`,
          `Duplicate storage constraint ${JSON.stringify(key)}`
        );
      }
      seenConstraints.add(key);
      validateStorageConstraint(
        constraint,
        `metadata.storageConstraints[${index}]`,
        machine,
        issues
      );
    }
  }

  validateRuntimeAdapter(machine, issues);

  const collectUserStringsFromExpr = (expr: Expr, into: Set<string>): void => {
    switch (expr.kind) {
      case "lit":
        if (typeof expr.value === "string") {
          into.add(expr.value);
        }
        return;
      case "param":
      case "var":
        return;
      case "index":
        collectUserStringsFromExpr(expr.target, into);
        collectUserStringsFromExpr(expr.key, into);
        return;
      case "set":
      case "and":
      case "or":
        for (const value of expr.values) {
          collectUserStringsFromExpr(value, into);
        }
        return;
      case "not":
        collectUserStringsFromExpr(expr.value, into);
        return;
      case "eq":
      case "lte":
        collectUserStringsFromExpr(expr.left, into);
        collectUserStringsFromExpr(expr.right, into);
        return;
      case "in":
        collectUserStringsFromExpr(expr.elem, into);
        collectUserStringsFromExpr(expr.set, into);
        return;
      case "count":
      case "forall":
        collectUserStringsFromExpr(expr.where, into);
        return;
    }
  };

  const userStringSet = new Set<string>();
  for (const variable of Object.values(machine.variables)) {
    if (variable.kind === "map") {
      collectUserStringsFromExpr(variable.initial, userStringSet);
    } else {
      collectUserStringsFromExpr(variable.initial, userStringSet);
    }
  }
  for (const action of Object.values(machine.actions)) {
    collectUserStringsFromExpr(action.guard, userStringSet);
    for (const update of action.updates) {
      if (update.kind === "setVar") {
        collectUserStringsFromExpr(update.value, userStringSet);
      } else {
        collectUserStringsFromExpr(update.key, userStringSet);
        collectUserStringsFromExpr(update.value, userStringSet);
      }
    }
  }
  for (const invariant of Object.values(machine.invariants)) {
    collectUserStringsFromExpr(invariant.formula, userStringSet);
  }
  for (const variable of Object.values(machine.variables)) {
    const type = variable.kind === "scalar" ? variable.type : variable.codomain;
    const collectStringsFromType = (valueType: ValueType): void => {
      switch (valueType.kind) {
        case "enum":
          for (const value of valueType.values) {
            userStringSet.add(value);
          }
          return;
        case "option":
          collectStringsFromType(valueType.value);
          return;
        case "union":
          for (const member of valueType.members) {
            collectStringsFromType(member);
          }
          return;
        default:
          return;
      }
    };
    collectStringsFromType(type);
  }
  for (const tier of Object.values(machine.proof.tiers)) {
    for (const domain of Object.values(tier.domains)) {
      if (domain.kind === "values") {
        for (const value of domain.values) {
          userStringSet.add(value);
        }
      }
    }
  }

  validateTierDomains(machine, issues, domainReferences, [...userStringSet]);

  return [...issues].sort(compareIssues);
};

export const assertValidMachine = (machine: MachineDef): void => {
  const issues = validateMachine(machine);
  if (issues.length === 0) {
    return;
  }

  const lines = issues.map((issue) => `[${issue.code}] ${issue.path}: ${issue.message}`);
  throw new Error(`Invalid machine ${machine.moduleName}\n${lines.join("\n")}`);
};
