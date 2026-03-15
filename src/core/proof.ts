import type {
  Expr,
  JsonValue,
  MachineDef,
  MachineEstimate,
  MachineEstimateFactor,
  ProofDomainDef,
  ResolvedMachineDef,
  ResolvedProofTier,
  ValueType,
  VariableDef
} from "./dsl.js";
import { NULL_SENTINEL, RESERVED_DOMAIN_VALUE, assertIdentifier } from "./encoding.js";
import { assertValidMachine } from "./validate.js";

const bigintPower = (base: bigint, exponent: bigint): bigint => {
  let result = 1n;
  let currentBase = base;
  let currentExponent = exponent;

  while (currentExponent > 0n) {
    if (currentExponent % 2n === 1n) {
      result *= currentBase;
    }
    currentBase *= currentBase;
    currentExponent /= 2n;
  }

  return result;
};

const formatBigInt = (value: bigint): string => {
  const source = value.toString();
  return source.replace(/\B(?=(\d{3})+(?!\d))/g, "_");
};

const renderDomainValues = (domain: ProofDomainDef): readonly string[] => {
  switch (domain.kind) {
    case "modelValues":
      assertIdentifier(domain.prefix, `Model value prefix for ${domain.prefix}`);
      if (domain.size < 1) {
        throw new Error(`Model value domain ${domain.prefix} must have size >= 1`);
      }
      return Array.from({ length: domain.size }, (_, index) => `${domain.prefix}${index + 1}`);
    case "ids":
      if (domain.size < 1) {
        throw new Error(`ID domain ${domain.prefix} must have size >= 1`);
      }
      return Array.from({ length: domain.size }, (_, index) => `${domain.prefix}${index + 1}`);
    case "values":
      if (domain.values.length === 0) {
        throw new Error("Explicit proof domains must contain at least one value");
      }
      return domain.values;
  }
};

const collectTypeDomains = (type: ValueType, domains: Set<string>): void => {
  switch (type.kind) {
    case "enum":
    case "boolean":
    case "null":
      return;
    case "domain":
      domains.add(type.name);
      return;
    case "range":
      if (!Number.isInteger(type.min) || !Number.isInteger(type.max)) {
        throw new Error(`Range bounds must be integers; received ${type.min}..${type.max}`);
      }
      if (type.max < type.min) {
        throw new Error(`Invalid range ${type.min}..${type.max}`);
      }
      return;
    case "option":
      collectTypeDomains(type.value, domains);
      return;
    case "union":
      for (const member of type.members) {
        collectTypeDomains(member, domains);
      }
      return;
  }
};

const collectExprDomains = (expr: Expr, domains: Set<string>): void => {
  switch (expr.kind) {
    case "lit":
    case "param":
    case "var":
      return;
    case "index":
      collectExprDomains(expr.target, domains);
      collectExprDomains(expr.key, domains);
      return;
    case "set":
    case "and":
    case "or":
      for (const value of expr.values) {
        collectExprDomains(value, domains);
      }
      return;
    case "not":
      collectExprDomains(expr.value, domains);
      return;
    case "eq":
    case "lte":
      collectExprDomains(expr.left, domains);
      collectExprDomains(expr.right, domains);
      return;
    case "in":
      collectExprDomains(expr.elem, domains);
      collectExprDomains(expr.set, domains);
      return;
    case "count":
    case "forall":
      domains.add(expr.domain);
      collectExprDomains(expr.where, domains);
      return;
  }
};

const collectReferencedDomains = (machine: MachineDef): Set<string> => {
  const domains = new Set<string>();

  for (const variable of Object.values(machine.variables)) {
    if (variable.kind === "map") {
      domains.add(variable.domain);
      collectTypeDomains(variable.codomain, domains);
    } else {
      collectTypeDomains(variable.type, domains);
    }
    collectExprDomains(variable.initial, domains);
  }

  for (const action of Object.values(machine.actions)) {
    for (const domainName of Object.values(action.params)) {
      domains.add(domainName);
    }
    collectExprDomains(action.guard, domains);
    for (const update of action.updates) {
      if (update.kind === "setVar") {
        collectExprDomains(update.value, domains);
      } else {
        collectExprDomains(update.key, domains);
        collectExprDomains(update.value, domains);
      }
    }
  }

  for (const invariant of Object.values(machine.invariants)) {
    collectExprDomains(invariant.formula, domains);
  }

  return domains;
};

const literalValuesForType = (
  type: ValueType,
  domains: Record<string, readonly string[]>
): readonly JsonValue[] => {
  switch (type.kind) {
    case "enum":
      return type.values;
    case "domain": {
      const domain = domains[type.name];
      if (domain === undefined) {
        throw new Error(`Unknown proof domain ${type.name}`);
      }
      return domain;
    }
    case "boolean":
      return [false, true];
    case "range":
      return Array.from({ length: type.max - type.min + 1 }, (_, index) => type.min + index);
    case "null":
      return [null];
    case "option":
      return [null, ...literalValuesForType(type.value, domains)];
    case "union": {
      const seen = new Map<string, JsonValue>();
      for (const member of type.members) {
        for (const value of literalValuesForType(member, domains)) {
          const key = JSON.stringify(value);
          if (!seen.has(key)) {
            seen.set(key, value);
          }
        }
      }
      return [...seen.values()];
    }
  }
};

const cardinalityForType = (
  type: ValueType,
  domains: Record<string, readonly string[]>
): { cardinality: bigint; formula: string } => {
  switch (type.kind) {
    case "enum":
      return { cardinality: BigInt(type.values.length), formula: String(type.values.length) };
    case "domain": {
      const domain = domains[type.name];
      if (domain === undefined) {
        throw new Error(`Unknown proof domain ${type.name}`);
      }
      return { cardinality: BigInt(domain.length), formula: `|${type.name}|` };
    }
    case "boolean":
      return { cardinality: 2n, formula: "2" };
    case "range":
      return {
        cardinality: BigInt(type.max - type.min + 1),
        formula: `${type.min}..${type.max}`
      };
    case "null":
      return { cardinality: 1n, formula: "1" };
    case "option": {
      const inner = cardinalityForType(type.value, domains);
      return {
        cardinality: inner.cardinality + 1n,
        formula: `1 + (${inner.formula})`
      };
    }
    case "union": {
      const values = literalValuesForType(type, domains);
      const formulas = type.members.map((member) => cardinalityForType(member, domains).formula);
      return {
        cardinality: BigInt(values.length),
        formula: formulas.join(" + ")
      };
    }
  }
};

const estimateVariable = (
  name: string,
  variable: VariableDef,
  domains: Record<string, readonly string[]>
): { factor: MachineEstimateFactor; cardinality: bigint } => {
  if (variable.kind === "scalar") {
    const estimate = cardinalityForType(variable.type, domains);
    return {
      factor: {
        name,
        formula: estimate.formula,
        value: formatBigInt(estimate.cardinality)
      },
      cardinality: estimate.cardinality
    };
  }

  const domain = domains[variable.domain];
  if (domain === undefined) {
    throw new Error(`Unknown proof domain ${variable.domain}`);
  }
  const codomain = cardinalityForType(variable.codomain, domains);
  const cardinality = bigintPower(codomain.cardinality, BigInt(domain.length));
  return {
    factor: {
      name,
      formula: `(${codomain.formula})^|${variable.domain}|`,
      value: formatBigInt(cardinality)
    },
    cardinality
  };
};

const estimateAction = (
  name: string,
  params: Record<string, string>,
  domains: Record<string, readonly string[]>
): { factor: MachineEstimateFactor; cardinality: bigint } => {
  const entries = Object.values(params);
  if (entries.length === 0) {
    return {
      factor: { name, formula: "1", value: "1" },
      cardinality: 1n
    };
  }

  let cardinality = 1n;
  const formulas: string[] = [];
  for (const domainName of entries) {
    const domain = domains[domainName];
    if (domain === undefined) {
      throw new Error(`Unknown proof domain ${domainName}`);
    }
    cardinality *= BigInt(domain.length);
    formulas.push(`|${domainName}|`);
  }

  return {
    factor: {
      name,
      formula: formulas.join(" * "),
      value: formatBigInt(cardinality)
    },
    cardinality
  };
};

const validateTier = (
  machine: MachineDef,
  tierName: string,
  tier: ResolvedProofTier,
  concreteDomains: Record<string, readonly string[]>
): void => {
  const referencedDomains = collectReferencedDomains(machine);

  for (const domainName of referencedDomains) {
    if (tier.domains[domainName] === undefined) {
      throw new Error(`Tier ${tierName} is missing proof domain ${domainName}`);
    }
  }

  for (const domainName of Object.keys(tier.domains)) {
    if (!referencedDomains.has(domainName)) {
      throw new Error(`Tier ${tierName} declares unused proof domain ${domainName}`);
    }
  }

  const seenValues = new Map<string, string>();
  for (const [domainName, values] of Object.entries(concreteDomains)) {
    for (const value of values) {
      if (value === RESERVED_DOMAIN_VALUE) {
        throw new Error(`Tier ${tierName} cannot use reserved domain value ${RESERVED_DOMAIN_VALUE}`);
      }
      const owner = seenValues.get(value);
      if (owner !== undefined) {
        throw new Error(`Tier ${tierName} reuses proof value ${JSON.stringify(value)} across domains ${owner} and ${domainName}`);
      }
      seenValues.set(value, domainName);
    }
  }

  const propertyNames = new Set(Object.keys(machine.properties ?? {}));
  for (const propertyName of tier.properties) {
    if (!propertyNames.has(propertyName)) {
      throw new Error(`Tier ${tierName} references unknown property ${propertyName}`);
    }
  }

  const invariantNames = new Set(Object.keys(machine.invariants));
  for (const invariantName of tier.invariants) {
    if (!invariantNames.has(invariantName)) {
      throw new Error(`Tier ${tierName} references unknown invariant ${invariantName}`);
    }
  }

  if (tier.properties.length > 0 && tier.symmetryDomains.length > 0) {
    throw new Error(`Tier ${tierName} cannot combine symmetry reduction with temporal properties`);
  }
};

const resolveTier = (machine: MachineDef, tierName?: string): ResolvedProofTier => {
  if (machine.version !== 2) {
    throw new Error(`Unsupported machine version ${machine.version}`);
  }

  const resolvedTierName = tierName ?? machine.proof.defaultTier;
  const tier = machine.proof.tiers[resolvedTierName];
  if (tier === undefined) {
    throw new Error(`Unknown proof tier ${resolvedTierName}`);
  }

  const invariants = tier.invariants ?? Object.keys(machine.invariants);
  const properties = tier.properties ?? [];
  const symmetryDomains = Object.entries(tier.domains)
    .filter(([, domain]) => domain.kind === "modelValues" && domain.symmetry)
    .map(([name]) => name);

  return {
    name: resolvedTierName,
    domains: tier.domains,
    symmetryDomains,
    budgets: tier.budgets ?? {},
    checks: {
      deadlock: tier.checks?.deadlock ?? true
    },
    invariants,
    properties
  };
};

export const estimateMachine = (machine: MachineDef, tierName?: string): MachineEstimate => {
  assertValidMachine(machine);
  const tier = resolveTier(machine, tierName);
  const domains = Object.fromEntries(
    Object.entries(tier.domains).map(([name, domain]) => [name, renderDomainValues(domain)])
  );

  validateTier(machine, tier.name, tier, domains);

  const variableFactors: MachineEstimateFactor[] = [];
  const actionFactors: MachineEstimateFactor[] = [];

  let totalStates = 1n;
  for (const [name, variable] of Object.entries(machine.variables)) {
    const estimate = estimateVariable(name, variable, domains);
    variableFactors.push(estimate.factor);
    totalStates *= estimate.cardinality;
  }

  let totalBranching = 0n;
  for (const [name, action] of Object.entries(machine.actions)) {
    const estimate = estimateAction(name, action.params, domains);
    actionFactors.push(estimate.factor);
    totalBranching += estimate.cardinality;
  }

  const violations: string[] = [];
  const maxEstimatedStates = tier.budgets.maxEstimatedStates;
  if (maxEstimatedStates !== undefined && totalStates > BigInt(maxEstimatedStates)) {
    violations.push(
      `Estimated state count ${formatBigInt(totalStates)} exceeds budget ${formatBigInt(BigInt(maxEstimatedStates))}`
    );
  }

  const maxEstimatedBranching = tier.budgets.maxEstimatedBranching;
  if (maxEstimatedBranching !== undefined && totalBranching > BigInt(maxEstimatedBranching)) {
    violations.push(
      `Estimated branching ${formatBigInt(totalBranching)} exceeds budget ${formatBigInt(BigInt(maxEstimatedBranching))}`
    );
  }

  return {
    tier: tier.name,
    totalStateCount: formatBigInt(totalStates),
    totalBranching: formatBigInt(totalBranching),
    variables: variableFactors,
    actions: actionFactors,
    withinBudget: violations.length === 0,
    budgetViolations: violations
  };
};

export const resolveMachine = (machine: MachineDef, tierName?: string): ResolvedMachineDef => {
  assertValidMachine(machine);
  const resolvedTier = resolveTier(machine, tierName);
  const domains = Object.fromEntries(
    Object.entries(resolvedTier.domains).map(([name, domain]) => [name, renderDomainValues(domain)])
  );

  validateTier(machine, resolvedTier.name, resolvedTier, domains);
  const estimate = estimateMachine(machine, resolvedTier.name);

  return {
    ...machine,
    domains,
    resolvedTier,
    estimate
  };
};

export const assertWithinBudgets = (estimate: MachineEstimate): void => {
  if (!estimate.withinBudget) {
    throw new Error(estimate.budgetViolations.join("\n"));
  }
};

export const formatEstimate = (estimate: MachineEstimate): string =>
  JSON.stringify(
    {
      tier: estimate.tier,
      totalStateCount: estimate.totalStateCount,
      totalBranching: estimate.totalBranching,
      variables: estimate.variables,
      actions: estimate.actions,
      withinBudget: estimate.withinBudget,
      budgetViolations: estimate.budgetViolations
    },
    null,
    2
  );

export const NULL_VALUE = NULL_SENTINEL;
