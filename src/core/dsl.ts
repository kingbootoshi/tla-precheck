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

export interface PgColumnExpr {
  kind: "pgColumn";
  name: string;
}

export interface PgLiteralExpr {
  kind: "pgLiteral";
  value: Primitive;
}

export type RowValueExpr = PgColumnExpr | PgLiteralExpr;

export type RowPredicateExpr =
  | { kind: "pgEq"; left: RowValueExpr; right: RowValueExpr }
  | { kind: "pgInSet"; target: RowValueExpr; values: readonly Primitive[] }
  | { kind: "pgAnd"; values: readonly RowPredicateExpr[] }
  | { kind: "pgOr"; values: readonly RowPredicateExpr[] }
  | { kind: "pgNot"; value: RowPredicateExpr }
  | { kind: "pgIsNull"; value: RowValueExpr }
  | { kind: "pgIsNotNull"; value: RowValueExpr };

export interface PgUniqueWhereConstraintDef {
  kind: "pgUniqueWhere";
  name: string;
  schema: string;
  table: string;
  columns: readonly string[];
  where: RowPredicateExpr;
  backsInvariant?: string;
}

export interface PgCheckConstraintDef {
  kind: "pgCheck";
  name: string;
  schema: string;
  table: string;
  predicate: RowPredicateExpr;
  backsInvariant?: string;
}

export type StorageConstraintDef = PgUniqueWhereConstraintDef | PgCheckConstraintDef;

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
  storageConstraints?: readonly StorageConstraintDef[];
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

const MACHINE_EXPR_KINDS = new Set<Expr["kind"]>([
  "lit",
  "param",
  "var",
  "index",
  "set",
  "and",
  "or",
  "not",
  "eq",
  "lte",
  "in",
  "count",
  "forall"
]);

const ROW_VALUE_KINDS = new Set<RowValueExpr["kind"]>(["pgColumn", "pgLiteral"]);

const ROW_PREDICATE_KINDS = new Set<RowPredicateExpr["kind"]>([
  "pgEq",
  "pgInSet",
  "pgAnd",
  "pgOr",
  "pgNot",
  "pgIsNull",
  "pgIsNotNull"
]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isMachineExpr = (value: unknown): value is Expr =>
  isObject(value) &&
  typeof value.kind === "string" &&
  MACHINE_EXPR_KINDS.has(value.kind as Expr["kind"]);

const isRowValueExpr = (value: unknown): value is RowValueExpr =>
  isObject(value) &&
  typeof value.kind === "string" &&
  ROW_VALUE_KINDS.has(value.kind as RowValueExpr["kind"]);

const isRowPredicateExpr = (value: unknown): value is RowPredicateExpr =>
  isObject(value) &&
  typeof value.kind === "string" &&
  ROW_PREDICATE_KINDS.has(value.kind as RowPredicateExpr["kind"]);

const isPrimitiveValue = (value: unknown): value is Primitive =>
  value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";

const toRowValueExpr = (value: Primitive | RowValueExpr): RowValueExpr => {
  if (isRowValueExpr(value)) {
    return value;
  }
  return { kind: "pgLiteral", value };
};

export const lit = (value: JsonValue): Expr => ({ kind: "lit", value });
export const param = (name: string): Expr => ({ kind: "param", name });
export const variable = (name: string): Expr => ({ kind: "var", name });
export const index = (target: Expr, key: Expr): Expr => ({ kind: "index", target, key });
export const setOf = (...values: readonly Expr[]): Expr => ({ kind: "set", values });

export function and(...values: readonly Expr[]): Expr;
export function and(...values: readonly RowPredicateExpr[]): RowPredicateExpr;
export function and(
  ...values: readonly (Expr | RowPredicateExpr)[]
): Expr | RowPredicateExpr {
  if (values.length === 0 || values.every((value) => isMachineExpr(value))) {
    return { kind: "and", values: values as readonly Expr[] };
  }
  if (values.every((value) => isRowPredicateExpr(value))) {
    return { kind: "pgAnd", values: values as readonly RowPredicateExpr[] };
  }
  throw new Error("and() operands must all be machine expressions or all be row predicates");
}

export function or(...values: readonly Expr[]): Expr;
export function or(...values: readonly RowPredicateExpr[]): RowPredicateExpr;
export function or(
  ...values: readonly (Expr | RowPredicateExpr)[]
): Expr | RowPredicateExpr {
  if (values.length === 0 || values.every((value) => isMachineExpr(value))) {
    return { kind: "or", values: values as readonly Expr[] };
  }
  if (values.every((value) => isRowPredicateExpr(value))) {
    return { kind: "pgOr", values: values as readonly RowPredicateExpr[] };
  }
  throw new Error("or() operands must all be machine expressions or all be row predicates");
}

export function not(value: Expr): Expr;
export function not(value: RowPredicateExpr): RowPredicateExpr;
export function not(value: Expr | RowPredicateExpr): Expr | RowPredicateExpr {
  if (isMachineExpr(value)) {
    return { kind: "not", value };
  }
  if (isRowPredicateExpr(value)) {
    return { kind: "pgNot", value };
  }
  throw new Error("not() operand must be a machine expression or row predicate");
}

export function eq(left: Expr, right: Expr): Expr;
export function eq(left: Primitive | RowValueExpr, right: Primitive | RowValueExpr): RowPredicateExpr;
export function eq(
  left: Expr | Primitive | RowValueExpr,
  right: Expr | Primitive | RowValueExpr
): Expr | RowPredicateExpr {
  if (isMachineExpr(left) && isMachineExpr(right)) {
    return { kind: "eq", left, right };
  }
  if ((isPrimitiveValue(left) || isRowValueExpr(left)) && (isPrimitiveValue(right) || isRowValueExpr(right))) {
    return { kind: "pgEq", left: toRowValueExpr(left), right: toRowValueExpr(right) };
  }
  throw new Error("eq() operands must both be machine expressions or both be row values");
}

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

export const col = (name: string): RowValueExpr => ({ kind: "pgColumn", name });
export const inSet = (
  target: Primitive | RowValueExpr,
  values: readonly Primitive[]
): RowPredicateExpr => ({
  kind: "pgInSet",
  target: toRowValueExpr(target),
  values
});
export const isNull = (value: Primitive | RowValueExpr): RowPredicateExpr => ({
  kind: "pgIsNull",
  value: toRowValueExpr(value)
});
export const isNotNull = (value: Primitive | RowValueExpr): RowPredicateExpr => ({
  kind: "pgIsNotNull",
  value: toRowValueExpr(value)
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

export const pgUniqueWhere = (
  constraint: Omit<PgUniqueWhereConstraintDef, "kind" | "schema"> & { schema?: string }
): PgUniqueWhereConstraintDef => ({
  ...constraint,
  kind: "pgUniqueWhere",
  schema: constraint.schema ?? "public"
});

export const pgCheck = (
  constraint: Omit<PgCheckConstraintDef, "kind" | "schema"> & { schema?: string }
): PgCheckConstraintDef => ({
  ...constraint,
  kind: "pgCheck",
  schema: constraint.schema ?? "public"
});
