import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { defineMachine, enumType, lit, scalarVar, setVar, variable } from "./dsl.js";
import { enabled, buildInitialState, exploreGraph, step } from "./interpreter.js";
import { resolveMachine } from "./proof.js";
import { agentRunsMachine } from "../examples/agentRuns.machine.js";

describe("interpreter", () => {
  test("rejects action params outside the declared proof domain", () => {
    const machine = resolveMachine(agentRunsMachine, "pr");
    const initial = buildInitialState(machine);

    assert.equal(enabled(machine, initial, "create", { u: "ghost", r: "r1" }), false);
    assert.equal(enabled(machine, initial, "create", { u: "u1" }), false);
    assert.equal(enabled(machine, initial, "create", { u: "u1", r: "r1", extra: "x" }), false);
    assert.equal(step(machine, initial, "create", { u: "ghost", r: "r1" }), null);
  });

  test("records binding-sensitive action labels in the explored graph", () => {
    const machine = resolveMachine(agentRunsMachine, "pr");
    const graph = exploreGraph(machine);

    assert.ok(graph.edges.some((edge) => edge.action === 'create(u1,"r1")'));
    assert.ok(graph.edges.some((edge) => edge.action === 'claimBackground("r1")'));
  });

  test("applies updates with simultaneous-assignment semantics", () => {
    const machine = resolveMachine(
      defineMachine({
        version: 2,
        moduleName: "SwapRegisters",
        variables: {
          left: scalarVar(enumType("cold", "hot"), lit("cold")),
          right: scalarVar(enumType("cold", "hot"), lit("hot"))
        },
        actions: {
          swap: {
            params: {},
            guard: lit(true),
            updates: [setVar("left", variable("right")), setVar("right", variable("left"))]
          }
        },
        invariants: {},
        proof: {
          defaultTier: "pr",
          tiers: {
            pr: {
              domains: {}
            }
          }
        }
      }),
      "pr"
    );

    const initial = buildInitialState(machine);
    const next = step(machine, initial, "swap", {});

    assert.deepEqual(next, {
      left: "hot",
      right: "cold"
    });
  });
});
