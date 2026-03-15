import type { Primitive, RowPredicateExpr, RowValueExpr } from "../core/dsl.js";

export type ThreeValuedBoolean = boolean | null;

export type RowPredicateColumnKind = "string" | "number" | "boolean";

export interface RowPredicateColumnType {
  kind: RowPredicateColumnKind;
  sqlType: string;
}

export type RowPredicateWitnessRow = Record<string, Primitive>;

const pushUnique = <T>(values: T[], value: T): void => {
  if (!values.includes(value)) {
    values.push(value);
  }
};

const collectRowValueColumns = (value: RowValueExpr, columns: Set<string>): void => {
  if (value.kind === "pgColumn") {
    columns.add(value.name);
  }
};

export const collectRowPredicateColumns = (
  predicate: RowPredicateExpr
): readonly string[] => {
  const columns = new Set<string>();

  const visit = (value: RowPredicateExpr): void => {
    switch (value.kind) {
      case "pgEq":
        collectRowValueColumns(value.left, columns);
        collectRowValueColumns(value.right, columns);
        return;
      case "pgInSet":
        collectRowValueColumns(value.target, columns);
        return;
      case "pgAnd":
      case "pgOr":
        for (const nested of value.values) {
          visit(nested);
        }
        return;
      case "pgNot":
        visit(value.value);
        return;
      case "pgIsNull":
      case "pgIsNotNull":
        collectRowValueColumns(value.value, columns);
        return;
    }
  };

  visit(predicate);
  return [...columns].sort((left, right) => left.localeCompare(right));
};

export const collectPredicateLiterals = (
  predicate: RowPredicateExpr
): ReadonlyMap<string, readonly Primitive[]> => {
  const literalsByColumn = new Map<string, Primitive[]>();

  const pushLiteral = (column: string, literal: Primitive): void => {
    const literals = literalsByColumn.get(column) ?? [];
    pushUnique(literals, literal);
    literalsByColumn.set(column, literals);
  };

  const visit = (value: RowPredicateExpr): void => {
    switch (value.kind) {
      case "pgEq":
        if (value.left.kind === "pgColumn" && value.right.kind === "pgLiteral") {
          pushLiteral(value.left.name, value.right.value);
        }
        if (value.left.kind === "pgLiteral" && value.right.kind === "pgColumn") {
          pushLiteral(value.right.name, value.left.value);
        }
        return;
      case "pgInSet":
        if (value.target.kind === "pgColumn") {
          for (const literal of value.values) {
            pushLiteral(value.target.name, literal);
          }
        }
        return;
      case "pgAnd":
      case "pgOr":
        for (const nested of value.values) {
          visit(nested);
        }
        return;
      case "pgNot":
        visit(value.value);
        return;
      case "pgIsNull":
      case "pgIsNotNull":
        return;
    }
  };

  visit(predicate);
  return new Map(
    [...literalsByColumn.entries()].map(([column, literals]) => [column, [...literals]])
  );
};

const evaluateRowValue = (
  value: RowValueExpr,
  row: RowPredicateWitnessRow
): Primitive => {
  if (value.kind === "pgLiteral") {
    return value.value;
  }

  if (!(value.name in row)) {
    throw new Error(`Missing witness row value for column ${JSON.stringify(value.name)}`);
  }

  return row[value.name];
};

const evaluateAnd = (values: readonly ThreeValuedBoolean[]): ThreeValuedBoolean => {
  let sawNull = false;
  for (const value of values) {
    if (value === false) {
      return false;
    }
    if (value === null) {
      sawNull = true;
    }
  }
  return sawNull ? null : true;
};

const evaluateOr = (values: readonly ThreeValuedBoolean[]): ThreeValuedBoolean => {
  let sawNull = false;
  for (const value of values) {
    if (value === true) {
      return true;
    }
    if (value === null) {
      sawNull = true;
    }
  }
  return sawNull ? null : false;
};

export const evaluateRowPredicate3vl = (
  predicate: RowPredicateExpr,
  row: RowPredicateWitnessRow
): ThreeValuedBoolean => {
  switch (predicate.kind) {
    case "pgEq": {
      const left = evaluateRowValue(predicate.left, row);
      const right = evaluateRowValue(predicate.right, row);
      if (left === null || right === null) {
        return null;
      }
      return left === right;
    }
    case "pgInSet": {
      const target = evaluateRowValue(predicate.target, row);
      if (target === null) {
        return null;
      }
      return predicate.values.includes(target);
    }
    case "pgAnd":
      return evaluateAnd(predicate.values.map((value) => evaluateRowPredicate3vl(value, row)));
    case "pgOr":
      return evaluateOr(predicate.values.map((value) => evaluateRowPredicate3vl(value, row)));
    case "pgNot": {
      const value = evaluateRowPredicate3vl(predicate.value, row);
      return value === null ? null : !value;
    }
    case "pgIsNull":
      return evaluateRowValue(predicate.value, row) === null;
    case "pgIsNotNull":
      return evaluateRowValue(predicate.value, row) !== null;
  }
};

const ensureLiteralKind = (
  column: string,
  kind: RowPredicateColumnKind,
  literal: Primitive
): void => {
  if (literal === null) {
    return;
  }
  if (kind === "string" && typeof literal === "string") {
    return;
  }
  if (kind === "number" && typeof literal === "number") {
    return;
  }
  if (kind === "boolean" && typeof literal === "boolean") {
    return;
  }
  throw new Error(
    `Predicate literal ${JSON.stringify(literal)} is not compatible with ${kind} column ${JSON.stringify(column)}`
  );
};

const nextStringValue = (
  taken: readonly string[],
  base: string
): string => {
  let candidate = base;
  let index = 0;
  while (taken.includes(candidate)) {
    index += 1;
    candidate = `${base}_${index}`;
  }
  return candidate;
};

const nextNumberValue = (
  taken: readonly number[],
  start: number
): number => {
  let candidate = start;
  while (taken.includes(candidate)) {
    candidate += 1;
  }
  return candidate;
};

const buildColumnCandidates = (
  column: string,
  type: RowPredicateColumnType,
  literals: readonly Primitive[]
): readonly Primitive[] => {
  for (const literal of literals) {
    ensureLiteralKind(column, type.kind, literal);
  }

  if (type.kind === "boolean") {
    const values: Primitive[] = [null];
    for (const literal of literals) {
      pushUnique(values, literal);
    }
    pushUnique(values, true);
    pushUnique(values, false);
    return values;
  }

  if (type.kind === "string") {
    const stringLiterals = literals.filter(
      (literal): literal is string => typeof literal === "string"
    );
    const extraA = nextStringValue(
      stringLiterals,
      "__probe_string_a__"
    );
    const extraB = nextStringValue(
      [...stringLiterals, extraA],
      "__probe_string_b__"
    );
    const values: Primitive[] = [null];
    for (const literal of stringLiterals) {
      pushUnique(values, literal);
    }
    pushUnique(values, extraA);
    pushUnique(values, extraB);
    return values;
  }

  const numberLiterals = literals.filter(
    (literal): literal is number => typeof literal === "number"
  );
  const extraA = nextNumberValue(numberLiterals, 0);
  const extraB = nextNumberValue([...numberLiterals, extraA], extraA + 1);
  const values: Primitive[] = [null];
  for (const literal of numberLiterals) {
    pushUnique(values, literal);
  }
  pushUnique(values, extraA);
  pushUnique(values, extraB);
  return values;
};

export const buildWitnessRows = (
  predicate: RowPredicateExpr,
  columnTypes: Readonly<Record<string, RowPredicateColumnType>>
): readonly RowPredicateWitnessRow[] => {
  const columns = collectRowPredicateColumns(predicate);
  if (columns.length === 0) {
    return [{}];
  }

  const literalsByColumn = collectPredicateLiterals(predicate);
  const candidatesByColumn = columns.map((column) => {
    const type = columnTypes[column];
    if (type === undefined) {
      throw new Error(`Missing column type for witness generation: ${JSON.stringify(column)}`);
    }
    return {
      column,
      values: buildColumnCandidates(column, type, literalsByColumn.get(column) ?? [])
    };
  });

  const rows: RowPredicateWitnessRow[] = [];

  const visit = (index: number, row: RowPredicateWitnessRow): void => {
    if (index >= candidatesByColumn.length) {
      rows.push({ ...row });
      return;
    }

    const candidate = candidatesByColumn[index];
    for (const value of candidate.values) {
      row[candidate.column] = value;
      visit(index + 1, row);
    }
  };

  visit(0, {});
  return rows;
};
