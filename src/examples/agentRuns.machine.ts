import {
  and,
  count,
  defineMachine,
  domainType,
  enumType,
  eq,
  forall,
  ids,
  index,
  isin,
  lit,
  lte,
  mapVar,
  modelValues,
  optionType,
  param,
  setMap,
  setOf,
  variable
} from "../core/dsl.js";

const status = variable("status");
const owner = variable("owner");

const runStatus = enumType("idle", "queued", "running", "completed", "failed", "cancelled");
const activeStatuses = setOf(lit("queued"), lit("running"));

export const agentRunsMachine = defineMachine({
  version: 2,
  moduleName: "AgentRuns",
  variables: {
    status: mapVar("Runs", runStatus, lit("idle")),
    owner: mapVar("Runs", optionType(domainType("Users")), lit(null))
  },
  actions: {
    create: {
      actor: "user",
      params: { u: "Users", r: "Runs" },
      guard: and(
        eq(index(status, param("r")), lit("idle")),
        eq(index(owner, param("r")), lit(null)),
        eq(
          count(
            "Runs",
            "candidate",
            and(
              eq(index(owner, param("candidate")), param("u")),
              isin(index(status, param("candidate")), activeStatuses)
            )
          ),
          lit(0)
        )
      ),
      updates: [setMap("status", param("r"), lit("queued")), setMap("owner", param("r"), param("u"))]
    },
    startDirect: {
      actor: "user",
      params: { r: "Runs" },
      guard: eq(index(status, param("r")), lit("queued")),
      updates: [setMap("status", param("r"), lit("running"))]
    },
    claimBackground: {
      actor: "background",
      params: { r: "Runs" },
      guard: eq(index(status, param("r")), lit("queued")),
      updates: [setMap("status", param("r"), lit("running"))]
    },
    complete: {
      actor: "server",
      params: { r: "Runs" },
      guard: eq(index(status, param("r")), lit("running")),
      updates: [setMap("status", param("r"), lit("completed"))]
    },
    fail: {
      actor: "server",
      params: { r: "Runs" },
      guard: eq(index(status, param("r")), lit("running")),
      updates: [setMap("status", param("r"), lit("failed"))]
    },
    cancel: {
      actor: "user",
      params: { r: "Runs" },
      guard: isin(index(status, param("r")), activeStatuses),
      updates: [setMap("status", param("r"), lit("cancelled"))]
    },
    sweepStale: {
      actor: "background",
      params: { r: "Runs" },
      guard: eq(index(status, param("r")), lit("running")),
      updates: [setMap("status", param("r"), lit("failed"))]
    }
  },
  invariants: {
    oneActivePerUser: {
      description: "At most one queued or running run per user",
      formula: forall(
        "Users",
        "u",
        lte(
          count(
            "Runs",
            "candidate",
            and(
              eq(index(owner, param("candidate")), param("u")),
              isin(index(status, param("candidate")), activeStatuses)
            )
          ),
          lit(1)
        )
      )
    }
  },
  proof: {
    defaultTier: "pr",
    tiers: {
      pr: {
        domains: {
          Users: modelValues("u", { size: 2, symmetry: true }),
          Runs: ids({ prefix: "r", size: 3 })
        },
        checks: {
          deadlock: false
        },
        budgets: {
          maxEstimatedStates: 10_000,
          maxEstimatedBranching: 30
        }
      },
      nightly: {
        domains: {
          Users: modelValues("u", { size: 3, symmetry: true }),
          Runs: ids({ prefix: "r", size: 5 })
        },
        checks: {
          deadlock: false
        },
        budgets: {
          maxEstimatedStates: 10_000_000,
          maxEstimatedBranching: 60
        }
      }
    }
  },
  metadata: {
    ownedTables: ["agent_runs"],
    ownedColumns: {
      agent_runs: ["status", "owner"]
    },
    allowedWriterModules: ["src/generated/agentRuns.adapter.ts"]
  }
});

export default agentRunsMachine;
