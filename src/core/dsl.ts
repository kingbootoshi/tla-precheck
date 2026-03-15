export type Primitive = string | number | boolean | null;
export type JsonValue = Primitive | JsonValue[] | { [key: string]: JsonValue };

export type ValueType =
  | { kind: "enum"; values: readonly string[] }
  | { kind: "domain"; name: string }
  | { kind: "boolean" }
  | { kind: "range"; min: number; max: number }
  | { kind: "null" }
  | { kind: "option"; value: ValueType }
  | { kind: "union"; members: readonly ValueType[] };

export type Expr =
  | { kind: "lit"; value: JsonValue }
  | { kind: "param"; name: string }
  | { kind: "var"; name: string }
  | { kind: "index"; target: Expr; key: Expr }
  | { kind: "set"; values: readonly Expr[] }
  | { kind: "and"; values: readonly Expr[] }
  | { kind: "or"; values: readonly Expr[] }
  | { kind: "not"; value: Expr }
  | { kind: "eq"; left: Expr; right: Expr }
  | { kind: "lte"; left: Expr; right: Expr }
  | { kind: "in"; elem: Expr; set: Expr }
  | { kind: "count"; domain: string; binder: string; where: Expr }
  | { kind: "forall"; domain: string; binder: string; where: Expr };

export type Update =
  | { kind: "setVar"; name: string; value: Expr }
  | { kind: "setMap"; name: string; key: Expr; value: Expr };

export interface ScalarVarDef {
  kind: "scalar";
  type: ValueType;
  initial: Expr;
}

export interface MapVarDef {
  kind: "map";
  domain: string;
  codomain: ValueType;
  initial: Expr;
}

export type VariableDef = ScalarVarDef | MapVarDef;

export interface ActionDef {
  actor?: string;
  params: Record<string, string>;
  guard: Expr;
  updates: readonly Update[];
}

export interface InvariantDef {
  description: string;
  formula: Expr;
}

export interface PropertyDef {
  description: string;
  formula: string;
}

export interface ModelValuesDomainDef {
  kind: "modelValues";
  prefix: string;
  size: number;
  symmetry?: boolean;
}

export interface IdsDomainDef {
  kind: "ids";
  prefix: string;
  size: number;
}

export interface DomainValuesDef {
  kind: "values";
  values: readonly string[];
}

export type ProofDomainDef = ModelValuesDomainDef | IdsDomainDef | DomainValuesDef;

export interface ProofBudgets {
  maxEstimatedStates?: number;
  maxEstimatedBranching?: number;
}

export interface ProofTierChecks {
  deadlock?: boolean;
}

export interface ProofTierDef {
  domains: Record<string, ProofDomainDef>;
  budgets?: ProofBudgets;
  checks?: ProofTierChecks;
  invariants?: readonly string[];
  properties?: readonly string[];
}

export interface MachineProofDef {
  defaultTier: string;
  tiers: Record<string, ProofTierDef>;
}

export interface MachineMetadata {
  ownedTables?: readonly string[];
  ownedColumns?: Record<string, readonly string[]>;
  allowedWriterModules?: readonly string[];
}

export interface MachineDef {
  version: 2;
  moduleName: string;
  variables: Record<string, VariableDef>;
  actions: Record<string, ActionDef>;
  invariants: Record<string, InvariantDef>;
  properties?: Record<string, PropertyDef>;
  proof: MachineProofDef;
  metadata?: MachineMetadata;
}

export interface MachineEstimateFactor {
  name: string;
  formula: string;
  value: string;
}

export interface MachineEstimate {
  tier: string;
  totalStateCount: string;
  totalBranching: string;
  variables: readonly MachineEstimateFactor[];
  actions: readonly MachineEstimateFactor[];
  withinBudget: boolean;
  budgetViolations: readonly string[];
}

export interface ResolvedProofTier {
  name: string;
  domains: Record<string, ProofDomainDef>;
  symmetryDomains: readonly string[];
  budgets: ProofBudgets;
  checks: Required<ProofTierChecks>;
  invariants: readonly string[];
  properties: readonly string[];
}

export interface ResolvedMachineDef extends MachineDef {
  domains: Record<string, readonly string[]>;
  resolvedTier: ResolvedProofTier;
  estimate: MachineEstimate;
}

export const defineMachine = <const M extends MachineDef>(machine: M): M => machine;

export const lit = (value: JsonValue): Expr => ({ kind: "lit", value });
export const param = (name: string): Expr => ({ kind: "param", name });
export const variable = (name: string): Expr => ({ kind: "var", name });
export const index = (target: Expr, key: Expr): Expr => ({ kind: "index", target, key });
export const setOf = (...values: readonly Expr[]): Expr => ({ kind: "set", values });
export const and = (...values: readonly Expr[]): Expr => ({ kind: "and", values });
export const or = (...values: readonly Expr[]): Expr => ({ kind: "or", values });
export const not = (value: Expr): Expr => ({ kind: "not", value });
export const eq = (left: Expr, right: Expr): Expr => ({ kind: "eq", left, right });
export const lte = (left: Expr, right: Expr): Expr => ({ kind: "lte", left, right });
export const isin = (elem: Expr, set: Expr): Expr => ({ kind: "in", elem, set });
export const count = (domain: string, binder: string, where: Expr): Expr => ({
  kind: "count",
  domain,
  binder,
  where
});
export const forall = (domain: string, binder: string, where: Expr): Expr => ({
  kind: "forall",
  domain,
  binder,
  where
});

export const enumType = (...values: readonly string[]): ValueType => ({ kind: "enum", values });
export const domainType = (name: string): ValueType => ({ kind: "domain", name });
export const boolType = (): ValueType => ({ kind: "boolean" });
export const rangeType = (min: number, max: number): ValueType => ({ kind: "range", min, max });
export const nullType = (): ValueType => ({ kind: "null" });
export const optionType = (value: ValueType): ValueType => ({ kind: "option", value });
export const unionType = (...members: readonly ValueType[]): ValueType => ({ kind: "union", members });

export const scalarVar = (type: ValueType, initial: Expr): ScalarVarDef => ({
  kind: "scalar",
  type,
  initial
});

export const mapVar = (domain: string, codomain: ValueType, initial: Expr): MapVarDef => ({
  kind: "map",
  domain,
  codomain,
  initial
});

export const setVar = (name: string, value: Expr): Update => ({ kind: "setVar", name, value });
export const setMap = (name: string, key: Expr, value: Expr): Update => ({
  kind: "setMap",
  name,
  key,
  value
});

export const modelValues = (
  prefix: string,
  options: { size: number; symmetry?: boolean }
): ModelValuesDomainDef => ({
  kind: "modelValues",
  prefix,
  size: options.size,
  symmetry: options.symmetry ?? false
});

export const ids = (options: { size: number; prefix?: string }): IdsDomainDef => ({
  kind: "ids",
  prefix: options.prefix ?? "id",
  size: options.size
});

export const domainValues = (...values: readonly string[]): DomainValuesDef => ({
  kind: "values",
  values
});
