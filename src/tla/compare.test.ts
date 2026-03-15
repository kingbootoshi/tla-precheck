import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { resolveMachine } from "../core/proof.js";
import { stableStringify } from "../core/stable.js";
import { agentRunsMachine } from "../examples/agentRuns.machine.js";
import { compareGraphs } from "./compare.js";

describe("graph comparison", () => {
  test("fails when the same edge uses different parameter bindings", () => {
    const machine = resolveMachine(agentRunsMachine, "pr");
    const initialState = {
      owner: { r1: null, r2: null, r3: null },
      status: { r1: "idle", r2: "idle", r3: "idle" }
    };
    const queuedByU1 = {
      owner: { r1: "u1", r2: null, r3: null },
      status: { r1: "queued", r2: "idle", r3: "idle" }
    };

    const initial = stableStringify(initialState);
    const next = stableStringify(queuedByU1);
    const states = new Map<
      string,
      {
        owner: { r1: string | null; r2: string | null; r3: string | null };
        status: { r1: string; r2: string; r3: string };
      }
    >([
      [initial, initialState],
      [next, queuedByU1]
    ]);

    const certificate = compareGraphs(
      machine,
      {
        initial: [initial],
        states,
        edges: [{ from: initial, to: next, action: 'create(u1,"r1")' }]
      },
      {
        initial: [initial],
        states,
        edges: [{ from: initial, to: next, action: 'create(u2,"r1")' }]
      }
    );

    assert.equal(certificate.equivalent, false);
  });
});
