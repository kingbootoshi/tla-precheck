import assert from "node:assert/strict";
import { describe, test } from "node:test";

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
});
