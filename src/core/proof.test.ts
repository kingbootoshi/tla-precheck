import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  defineMachine,
  enumType,
  ids,
  lit,
  mapVar,
  modelValues,
  scalarVar,
  setVar
} from "./dsl.js";
import {
  assertSafeForGraphEquivalence,
  assertWithinBudgets,
  estimateMachine,
  resolveMachine
} from "./proof.js";
import { agentRunsMachine } from "../examples/agentRuns.machine.js";

describe("proof tiers", () => {
  test("estimates the PR tier state space and branching", () => {
    const estimate = estimateMachine(agentRunsMachine, "pr");

    assert.equal(estimate.totalStateCount, "5_832");
    assert.equal(estimate.totalBranching, "24");
    assert.equal(estimate.withinBudget, true);
  });

  test("fails fast when a tier budget is exceeded", () => {
    const estimate = estimateMachine(
      defineMachine({
        ...agentRunsMachine,
        proof: {
          ...agentRunsMachine.proof,
          tiers: {
            ...agentRunsMachine.proof.tiers,
            pr: {
              ...agentRunsMachine.proof.tiers.pr,
              budgets: {
                maxEstimatedStates: 10,
                maxEstimatedBranching: 5
              }
            }
          }
        }
      }),
      "pr"
    );

    assert.throws(() => assertWithinBudgets(estimate), /Estimated state count 5_832 exceeds budget 10/);
  });

  test("rejects symmetry on temporal tiers", () => {
    const temporalMachine = defineMachine({
      version: 2,
      moduleName: "TemporalGuard",
      variables: {
        status: scalarVar(enumType("idle", "running"), lit("idle"))
      },
      actions: {
        tick: {
          params: { u: "Users" },
          guard: lit(true),
          updates: [setVar("status", lit("running"))]
        }
      },
      invariants: {},
      properties: {
        eventuallyRunning: {
          description: "Status eventually becomes running",
          formula: "<>(status = \"running\")"
        }
      },
      proof: {
        defaultTier: "liveness",
        tiers: {
          liveness: {
            domains: {
              Users: modelValues("u", { size: 2, symmetry: true })
            },
            properties: ["eventuallyRunning"]
          }
        }
      }
    });

    assert.throws(
      () => resolveMachine(temporalMachine, "liveness"),
      /cannot combine symmetry reduction with temporal properties/
    );
  });

  test("rejects graph equivalence when the resolved state estimate exceeds the hard cap", () => {
    const machine = resolveMachine(
      defineMachine({
        version: 2,
        moduleName: "HugeGraphEquivalenceStates",
        variables: {
          status: mapVar(
            "Runs",
            enumType(
              "s1",
              "s2",
              "s3",
              "s4",
              "s5",
              "s6",
              "s7",
              "s8",
              "s9",
              "s10",
              "s11"
            ),
            lit("s1")
          )
        },
        actions: {},
        invariants: {},
        proof: {
          defaultTier: "pr",
          tiers: {
            pr: {
              domains: {
                Runs: ids({ prefix: "r", size: 5 })
              }
            }
          }
        }
      }),
      "pr"
    );

    assert.throws(
      () => assertSafeForGraphEquivalence(machine),
      /exceeds the hard graph-equivalence cap 100_000/
    );
  });

  test("rejects graph equivalence when the resolved branching estimate exceeds the hard cap", () => {
    const machine = resolveMachine(
      defineMachine({
        version: 2,
        moduleName: "HugeGraphEquivalenceBranching",
        variables: {
          status: scalarVar(enumType("idle", "queued"), lit("idle"))
        },
        actions: {
          branch: {
            params: {
              a: "Runs",
              b: "Runs",
              c: "Runs"
            },
            guard: lit(true),
            updates: [setVar("status", lit("queued"))]
          }
        },
        invariants: {},
        proof: {
          defaultTier: "pr",
          tiers: {
            pr: {
              domains: {
                Runs: ids({ prefix: "r", size: 22 })
              }
            }
          }
        }
      }),
      "pr"
    );

    assert.throws(
      () => assertSafeForGraphEquivalence(machine),
      /exceeds the hard graph-equivalence cap 10_000/
    );
  });
});
