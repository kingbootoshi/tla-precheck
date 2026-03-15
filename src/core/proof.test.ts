import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  defineMachine,
  enumType,
  lit,
  modelValues,
  scalarVar,
  setVar
} from "./dsl.js";
import { assertWithinBudgets, estimateMachine, resolveMachine } from "./proof.js";
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
});
