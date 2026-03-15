import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { buildInitialState, exploreGraph, step } from "../core/interpreter.js";
import { estimateMachine, resolveMachine } from "../core/proof.js";
import { dogMachine } from "./dog.machine.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

describe("Dog machine", () => {
  test("keeps the proof tier small and predictable", () => {
    const estimate = estimateMachine(dogMachine, "pr");

    assert.equal(estimate.totalStateCount, "6");
    assert.equal(estimate.totalBranching, "6");
    assert.equal(estimate.withinBudget, true);
  });

  test("reaches only the intended dog states", () => {
    const machine = resolveMachine(dogMachine, "pr");
    const graph = exploreGraph(machine);

    assert.equal(graph.states.size, 4);
    assert.equal(graph.edges.length, 6);
    assert.ok(
      [...graph.states.values()].every(
        (state) =>
          !(isRecord(state) && state["mode"] === "sleeping" && state["temper"] === "angry")
      )
    );
    assert.ok(
      [...graph.states.values()].every(
        (state) =>
          !(isRecord(state) && state["mode"] === "eating" && state["temper"] === "angry")
      )
    );
  });

  test("disables transitions that are not enabled in the current state", () => {
    const machine = resolveMachine(dogMachine, "pr");
    const initial = buildInitialState(machine);

    assert.equal(step(machine, initial, "serveFood", {}), null);
  });
});
