import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  and,
  col,
  defineMachine,
  domainType,
  enumType,
  eq,
  forall,
  ids,
  index,
  lit,
  mapVar,
  modelValues,
  optionType,
  param,
  pgCheck,
  scalarVar,
  setMap,
  setVar,
  variable
} from "./dsl.js";
import { agentRunsMachine } from "../examples/agentRuns.machine.js";
import { assertValidMachine, validateMachine } from "./validate.js";

const issueCodes = (machine: Parameters<typeof validateMachine>[0]): readonly string[] =>
  validateMachine(machine).map((issue) => issue.code);

describe("machine validation", () => {
  test("accepts the example machine", () => {
    assert.deepEqual(validateMachine(agentRunsMachine), []);
    assert.doesNotThrow(() => assertValidMachine(agentRunsMachine));
  });

  test("rejects repeated writes and composite literals", () => {
    const machine = defineMachine({
      version: 2,
      moduleName: "RepeatedWrites",
      variables: {
        left: scalarVar(enumType("idle", "ready"), lit("idle")),
        right: scalarVar(enumType("idle", "ready"), lit(["idle"]))
      },
      actions: {
        overwrite: {
          params: {},
          guard: lit(true),
          updates: [setVar("left", lit("ready")), setVar("left", variable("right"))]
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
    });

    assert.deepEqual(issueCodes(machine), [
      "duplicate-update-target",
      "unsupported-composite-literal"
    ]);
  });

  test("rejects bad update targets and index targets", () => {
    const machine = defineMachine({
      version: 2,
      moduleName: "BadTargets",
      variables: {
        status: scalarVar(enumType("idle", "queued"), lit("idle")),
        owner: mapVar("Runs", optionType(domainType("Users")), lit(null))
      },
      actions: {
        bad: {
          params: { r: "Runs" },
          guard: and(eq(index(variable("status"), param("r")), lit("idle")), eq(variable("ghost"), lit(null))),
          updates: [setMap("status", lit("r1"), lit("queued")), setVar("owner", lit(null))]
        }
      },
      invariants: {},
      proof: {
        defaultTier: "pr",
        tiers: {
          pr: {
            domains: {
              Users: modelValues("u", { size: 1 }),
              Runs: ids({ prefix: "r", size: 1 })
            }
          }
        }
      }
    });

    assert.deepEqual(issueCodes(machine), [
      "invalid-index-target",
      "unknown-variable",
      "invalid-update-kind",
      "invalid-update-kind"
    ]);
  });

  test("rejects reserved strings and model-value collisions", () => {
    const machine = defineMachine({
      version: 2,
      moduleName: "EncodingCollision",
      variables: {
        status: scalarVar(enumType("idle", "u1"), lit("__NULL__")),
        owner: scalarVar(optionType(domainType("Users")), lit(null))
      },
      actions: {},
      invariants: {},
      proof: {
        defaultTier: "pr",
        tiers: {
          pr: {
            domains: {
              Users: modelValues("u", { size: 1 })
            }
          }
        }
      }
    });

    assert.deepEqual(issueCodes(machine), [
      "model-value-string-collision",
      "reserved-string-literal"
    ]);
  });

  test("rejects invalid storage predicates", () => {
    const machine = defineMachine({
      version: 2,
      moduleName: "BadStorage",
      variables: {
        status: scalarVar(enumType("idle", "queued"), lit("idle"))
      },
      actions: {},
      invariants: {},
      proof: {
        defaultTier: "pr",
        tiers: {
          pr: {
            domains: {}
          }
        }
      },
      metadata: {
        ownedTables: ["agent_runs"],
        ownedColumns: {
          agent_runs: ["owner"]
        },
        storageConstraints: [
          pgCheck({
            name: "bad_storage",
            table: "agent_runs",
            predicate: eq(col("owner"), null)
          }),
          pgCheck({
            name: "wrong_column",
            table: "agent_runs",
            predicate: eq(col("status"), "queued")
          })
        ]
      }
    });

    assert.deepEqual(issueCodes(machine), [
      "pg-eq-null",
      "storage-column-not-owned"
    ]);
  });

  test("rejects oversized equivalence budgets", () => {
    const machine = defineMachine({
      ...agentRunsMachine,
      proof: {
        ...agentRunsMachine.proof,
        tiers: {
          ...agentRunsMachine.proof.tiers,
          pr: {
            ...agentRunsMachine.proof.tiers.pr,
            graphEquivalence: true,
            budgets: {
              maxEstimatedStates: 100_001
            }
          }
        }
      }
    });

    assert.ok(issueCodes(machine).includes("equivalence-budget-cap-exceeded"));
  });

  test("allows large budgets on proof-only tiers", () => {
    const machine = defineMachine({
      ...agentRunsMachine,
      proof: {
        ...agentRunsMachine.proof,
        tiers: {
          ...agentRunsMachine.proof.tiers,
          pr: {
            ...agentRunsMachine.proof.tiers.pr,
            graphEquivalence: false,
            budgets: {
              maxEstimatedStates: 10_000_000
            }
          }
        }
      }
    });

    assert.ok(!issueCodes(machine).includes("equivalence-budget-cap-exceeded"));
  });

  test("rejects proof domains larger than the hard cap", () => {
    const machine = defineMachine({
      ...agentRunsMachine,
      proof: {
        ...agentRunsMachine.proof,
        tiers: {
          ...agentRunsMachine.proof.tiers,
          pr: {
            ...agentRunsMachine.proof.tiers.pr,
            domains: {
              ...agentRunsMachine.proof.tiers.pr.domains,
              Runs: ids({ prefix: "r", size: 101 })
            }
          }
        }
      }
    });

    assert.ok(issueCodes(machine).includes("domain-size-cap-exceeded"));
  });

  test("rejects actions with more than four parameters", () => {
    const machine = defineMachine({
      version: 2,
      moduleName: "TooManyParams",
      variables: {
        status: scalarVar(enumType("idle", "queued"), lit("idle"))
      },
      actions: {
        explode: {
          params: { a: "Runs", b: "Runs", c: "Runs", d: "Runs", e: "Runs" },
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
              Runs: ids({ prefix: "r", size: 2 })
            }
          }
        }
      }
    });

    assert.ok(issueCodes(machine).includes("action-param-cap-exceeded"));
  });

  test("rejects runtime adapters on scalar machines", () => {
    const machine = defineMachine({
      version: 2,
      moduleName: "ScalarAdapter",
      variables: {
        status: scalarVar(enumType("idle", "queued"), lit("idle"))
      },
      actions: {},
      invariants: {},
      proof: {
        defaultTier: "pr",
        tiers: {
          pr: {
            domains: {
              Runs: ids({ prefix: "r", size: 2 })
            }
          }
        }
      },
      metadata: {
        ownedTables: ["agent_runs"],
        ownedColumns: {
          agent_runs: ["status"]
        },
        runtimeAdapter: {
          table: "agent_runs",
          rowDomain: "Runs",
          keyColumn: "id",
          keySqlType: "bigint"
        }
      }
    });

    assert.ok(issueCodes(machine).includes("adapter-map-only-machine-required"));
  });

  test("rejects runtime adapters with non-literal map initials", () => {
    const machine = defineMachine({
      version: 2,
      moduleName: "NonLiteralAdapterInitial",
      variables: {
        status: mapVar("Runs", enumType("idle", "queued"), variable("status"))
      },
      actions: {},
      invariants: {},
      proof: {
        defaultTier: "pr",
        tiers: {
          pr: {
            domains: {
              Runs: ids({ prefix: "r", size: 2 })
            }
          }
        }
      },
      metadata: {
        ownedTables: ["agent_runs"],
        ownedColumns: {
          agent_runs: ["status"]
        },
        runtimeAdapter: {
          table: "agent_runs",
          rowDomain: "Runs",
          keyColumn: "id",
          keySqlType: "bigint"
        }
      }
    });

    assert.ok(issueCodes(machine).includes("adapter-nonliteral-initial"));
  });

  test("rejects runtime adapter quantifiers over non-row domains in actions", () => {
    const machine = defineMachine({
      version: 2,
      moduleName: "AdapterQuantifierDomain",
      variables: {
        owner: mapVar("Runs", optionType(domainType("Users")), lit(null))
      },
      actions: {
        claim: {
          params: { r: "Runs" },
          guard: forall("Users", "u", eq(index(variable("owner"), param("r")), lit(null))),
          updates: [setMap("owner", param("r"), lit(null))]
        }
      },
      invariants: {},
      proof: {
        defaultTier: "pr",
        tiers: {
          pr: {
            domains: {
              Users: modelValues("u", { size: 2 }),
              Runs: ids({ prefix: "r", size: 2 })
            }
          }
        }
      },
      metadata: {
        ownedTables: ["agent_runs"],
        ownedColumns: {
          agent_runs: ["owner"]
        },
        runtimeAdapter: {
          table: "agent_runs",
          rowDomain: "Runs",
          keyColumn: "id",
          keySqlType: "bigint"
        }
      }
    });

    assert.ok(issueCodes(machine).includes("adapter-unsupported-quantifier-domain"));
  });
});
