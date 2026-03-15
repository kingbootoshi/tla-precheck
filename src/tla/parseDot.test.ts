import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { resolveMachine } from "../core/proof.js";
import { agentRunsMachine } from "../examples/agentRuns.machine.js";
import { dogMachine } from "../examples/dog.machine.js";
import { parseTlcDot } from "./parseDot.js";

describe("TLC DOT parsing", () => {
  test("preserves action bindings and resolves edges declared before nodes", () => {
    const machine = resolveMachine(agentRunsMachine, "pr");
    const source = String.raw`strict digraph DiskGraph {
1 -> 2 [label="create(u1,\"r1\")",color="black",fontcolor="black"];
1 [label="/\\ owner = [r1 |-> \"__NULL__\", r2 |-> \"__NULL__\", r3 |-> \"__NULL__\"]\n/\\ status = [r1 |-> \"idle\", r2 |-> \"idle\", r3 |-> \"idle\"]",style = filled];
2 [label="/\\ owner = [r1 |-> u1, r2 |-> \"__NULL__\", r3 |-> \"__NULL__\"]\n/\\ status = [r1 |-> \"queued\", r2 |-> \"idle\", r3 |-> \"idle\"]"];
}`;

    const graph = parseTlcDot(machine, source);
    const initialState = graph.states.get(graph.initial[0]);
    const queuedStateKey = [...graph.states.keys()].find((key) => key !== graph.initial[0]);

    assert.equal(graph.initial.length, 1);
    assert.deepEqual(initialState, {
      owner: { r1: null, r2: null, r3: null },
      status: { r1: "idle", r2: "idle", r3: "idle" }
    });
    assert.equal(graph.edges.length, 1);
    assert.equal(graph.edges[0]?.from, graph.initial[0]);
    assert.equal(graph.edges[0]?.to, queuedStateKey);
    assert.equal(graph.edges[0]?.action, 'create(u1,"r1")');
  });

  test("recognizes quoted filled styles on initial nodes", () => {
    const machine = resolveMachine(agentRunsMachine, "pr");
    const source = String.raw`strict digraph DiskGraph {
1 [label="/\\ owner = [r1 |-> \"__NULL__\", r2 |-> \"__NULL__\", r3 |-> \"__NULL__\"]\n/\\ status = [r1 |-> \"idle\", r2 |-> \"idle\", r3 |-> \"idle\"]",style="filled"];
}`;

    const graph = parseTlcDot(machine, source);

    assert.equal(graph.initial.length, 1);
  });

  test("maps generated wrapper action names back to canonical bindings", () => {
    const machine = resolveMachine(agentRunsMachine, "pr");
    const source = String.raw`strict digraph DiskGraph {
1 -> 2 [label="Action_create_1",color="black",fontcolor="black"];
1 [label="/\\ owner = [r1 |-> \"__NULL__\", r2 |-> \"__NULL__\", r3 |-> \"__NULL__\"]\n/\\ status = [r1 |-> \"idle\", r2 |-> \"idle\", r3 |-> \"idle\"]",style = filled];
2 [label="/\\ owner = [r1 |-> u1, r2 |-> \"__NULL__\", r3 |-> \"__NULL__\"]\n/\\ status = [r1 |-> \"queued\", r2 |-> \"idle\", r3 |-> \"idle\"]"];
}`;

    const graph = parseTlcDot(machine, source, {
      Action_create_1: 'create(u1,"r1")'
    });

    assert.equal(graph.edges[0]?.action, 'create(u1,"r1")');
  });

  test("parses multiline map assignments emitted for larger state labels", () => {
    const machine = resolveMachine(agentRunsMachine, "nightly");
    const source = String.raw`strict digraph DiskGraph {
1 [label="/\\ status = [r1 |-> \"idle\", r2 |-> \"idle\", r3 |-> \"idle\", r4 |-> \"idle\", r5 |-> \"idle\"]\n/\\ owner = [ r1 |-> \"__NULL__\",\n  r2 |-> \"u1\",\n  r3 |-> \"__NULL__\",\n  r4 |-> \"__NULL__\",\n  r5 |-> \"__NULL__\" ]",style = filled];
}`;

    const graph = parseTlcDot(machine, source);
    const initialState = graph.states.get(graph.initial[0]);

    assert.deepEqual(initialState, {
      owner: { r1: null, r2: "u1", r3: null, r4: null, r5: null },
      status: {
        r1: "idle",
        r2: "idle",
        r3: "idle",
        r4: "idle",
        r5: "idle"
      }
    });
  });

  test("parses scalar labels that omit the conjunction prefix", () => {
    const machine = resolveMachine(dogMachine, "pr");
    const source = String.raw`strict digraph DiskGraph {
1 [label="mode = \"sleeping\"\ntemper = \"calm\"",style = filled];
}`;

    const graph = parseTlcDot(machine, source);
    const initialState = graph.states.get(graph.initial[0]);

    assert.deepEqual(initialState, {
      mode: "sleeping",
      temper: "calm"
    });
  });

  test("throws when a state variable is missing", () => {
    const machine = resolveMachine(dogMachine, "pr");
    const source = String.raw`strict digraph DiskGraph {
1 [label="mode = \"sleeping\"",style = filled];
}`;

    assert.throws(
      () => parseTlcDot(machine, source),
      /Missing state variables in TLC node label: temper/
    );
  });

  test("throws when a state variable is duplicated", () => {
    const machine = resolveMachine(dogMachine, "pr");
    const source = String.raw`strict digraph DiskGraph {
1 [label="mode = \"sleeping\"\nmode = \"awake\"\ntemper = \"calm\"",style = filled];
}`;

    assert.throws(
      () => parseTlcDot(machine, source),
      /Duplicate assignment in TLC node label: mode/
    );
  });

  test("throws when a state variable is unexpected", () => {
    const machine = resolveMachine(dogMachine, "pr");
    const source = String.raw`strict digraph DiskGraph {
1 [label="mode = \"sleeping\"\ntemper = \"calm\"\nghost = TRUE",style = filled];
}`;

    assert.throws(
      () => parseTlcDot(machine, source),
      /Unexpected state variables in TLC node label: ghost/
    );
  });

  test("throws on malformed multiline continuation", () => {
    const machine = resolveMachine(dogMachine, "pr");
    const source = String.raw`strict digraph DiskGraph {
1 [label="\"sleeping\"\ntemper = \"calm\"",style = filled];
}`;

    assert.throws(
      () => parseTlcDot(machine, source),
      /Malformed multiline continuation without an active assignment/
    );
  });

  test("throws on trailing tokens after a parsed value", () => {
    const machine = resolveMachine(dogMachine, "pr");
    const source = String.raw`strict digraph DiskGraph {
1 [label="mode = \"sleeping\" TRUE\ntemper = \"calm\"",style = filled];
}`;

    assert.throws(
      () => parseTlcDot(machine, source),
      /Unexpected trailing tokens in assignment line/
    );
  });
});
