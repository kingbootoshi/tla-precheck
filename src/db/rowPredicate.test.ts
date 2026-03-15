import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { and, col, eq, inSet, isNotNull, not, or } from "../core/dsl.js";
import {
  buildWitnessRows,
  collectPredicateLiterals,
  collectRowPredicateColumns,
  evaluateRowPredicate3vl,
  type RowPredicateColumnType
} from "./rowPredicate.js";

describe("rowPredicate", () => {
  test("collects columns and literals deterministically", () => {
    const predicate = and(
      inSet(col("status"), ["queued", "running"]),
      or(eq(col("owner"), "u1"), isNotNull(col("owner")))
    );

    assert.deepEqual(collectRowPredicateColumns(predicate), ["owner", "status"]);
    assert.deepEqual(
      [...collectPredicateLiterals(predicate).entries()],
      [
        ["status", ["queued", "running"]],
        ["owner", ["u1"]]
      ]
    );
  });

  test("evaluates SQL three-valued logic locally", () => {
    const predicate = or(
      not(inSet(col("status"), ["queued", "running"])),
      isNotNull(col("owner"))
    );

    assert.equal(
      evaluateRowPredicate3vl(predicate, { status: "queued", owner: null }),
      false
    );
    assert.equal(
      evaluateRowPredicate3vl(predicate, { status: "queued", owner: "u1" }),
      true
    );
    assert.equal(
      evaluateRowPredicate3vl(predicate, { status: null, owner: null }),
      null
    );
  });

  test("builds witness rows that exercise both true and false column equality cases", () => {
    const predicate = eq(col("left"), col("right"));
    const columnTypes: Record<string, RowPredicateColumnType> = {
      left: { kind: "string", sqlType: "text" },
      right: { kind: "string", sqlType: "text" }
    };

    const rows = buildWitnessRows(predicate, columnTypes);
    const results = new Set(
      rows.map((row) => evaluateRowPredicate3vl(predicate, row))
    );

    assert.ok(results.has(true));
    assert.ok(results.has(false));
    assert.ok(results.has(null));
  });
});
