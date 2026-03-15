<p align="center">
  <img src="tla-precheck-banner.jpeg" alt="TLA PreCheck" width="100%" />
</p>

<h3 align="center">Find invisible bugs in your state machine design before writing a single line of code.<br/>Then generate the proven-correct code from the same source.</h3>

<p align="center">
  <a href="#the-problem">The Problem</a> -
  <a href="#how-it-works">How It Works</a> -
  <a href="#before-and-after">Before & After</a> -
  <a href="#install">Install</a> -
  <a href="#the-design-loop">The Design Loop</a> -
  <a href="docs/TECHNICAL-REFERENCE.md">Technical Reference</a>
</p>

---

Write your state machine once. The compiler mathematically checks every possible state
for bugs, then generates the runtime code. One source of truth. No drift. No if/else
chains. No praying your guards are consistent across services.

TLA PreCheck uses [TLA+](https://lamport.azurewebsites.net/tla/tla.html) model checking
under the hood - the same math Amazon used to find bugs in DynamoDB that no amount of
testing could catch. You don't need to know TLA+. You write TypeScript. The compiler
handles the rest.

## How It Works

You write the state machine once in a restricted TypeScript DSL. The compiler generates
everything else:

```
                                    +---> TLA+ Spec -----------> TLC Model Checker (proves design correct)
                                    |
Machine DSL (one source of truth) --+---> TypeScript Interpreter (runtime execution)
                                    |
                                    +---> Generated Adapter ----> Typed functions you import
                                    |
                                    +---> Postgres DDL ---------> Database-level enforcement
```

Then it proves the TLA+ spec and the TypeScript interpreter produce **bit-identical state
graphs** across every reachable state. Not "similar." Identical. Mathematically verified.

If they diverge, your build fails. If an invariant is violated in any reachable state,
your build fails. No bugs ship.

## Before and After

**Before: scattered if/else guards across your codebase**

```typescript
// api/runs/cancel.ts - hope this matches the other 6 places that check run status
if (run.status === "queued" || run.status === "running") {
  if (run.owner === userId || isAdmin(userId)) {
    await db.update("agent_runs", { id: runId, status: "cancelled" });
  } else {
    throw new Error("Not authorized to cancel this run");
  }
} else {
  throw new Error("Cannot cancel a run that is not active");
}

// api/runs/complete.ts - is this consistent with cancel? who knows
if (run.status === "running") {
  await db.update("agent_runs", { id: runId, status: "completed" });
} else {
  throw new Error("Can only complete a running run");
}

// background/sweep.ts - third place with status logic, probably slightly different
if (run.status === "running" && isStale(run)) {
  await db.update("agent_runs", { id: runId, status: "failed" });
}
```

**After: one DSL, proven correct, generated functions**

```typescript
// The machine - every guard, every transition, every invariant in one place
export const agentRunsMachine = defineMachine({
  version: 2,
  moduleName: "AgentRuns",
  variables: {
    status: mapVar("Runs", enumType("idle", "queued", "running", "completed", "failed", "cancelled"), lit("idle")),
    owner: mapVar("Runs", optionType(domainType("Users")), lit(null))
  },
  actions: {
    create: {
      params: { u: "Users", r: "Runs" },
      guard: and(
        eq(index(status, param("r")), lit("idle")),
        eq(index(owner, param("r")), lit(null)),
        eq(count("Runs", "c", and(
          eq(index(owner, param("c")), param("u")),
          isin(index(status, param("c")), activeStatuses)
        )), lit(0))
      ),
      updates: [
        setMap("status", param("r"), lit("queued")),
        setMap("owner", param("r"), param("u"))
      ]
    },
    cancel: {
      params: { r: "Runs" },
      guard: isin(index(status, param("r")), activeStatuses),
      updates: [setMap("status", param("r"), lit("cancelled"))]
    },
    // complete, fail, sweepStale...
  },
  invariants: {
    oneActivePerUser: {
      description: "At most one queued or running run per user",
      formula: forall("Users", "u", lte(
        count("Runs", "c", and(
          eq(index(owner, param("c")), param("u")),
          isin(index(status, param("c")), activeStatuses)
        )),
        lit(1)
      ))
    }
  }
});
```

```typescript
// Your application code - no if/else, no guards, just function calls
import { create, cancel, complete } from "./machine-adapters/AgentRuns.adapter";

// Each function: opens transaction, locks rows, runs proven interpreter,
// diffs state, writes changes. If transition is invalid, throws.
await create(sql, { u: userId, r: runId });
await cancel(sql, { r: runId });
await complete(sql, { r: runId });
```

The scattered if/else checks are gone. The guard logic lives in the DSL, was proven
correct by the model checker across every possible state, and executes inside the
generated adapter. Your code just calls functions.

## The Mathematical Guarantee

When TLA PreCheck passes:

1. **Design is correct** - TLC exhaustively checked every reachable state, every
   interleaving, every edge case. Not sampled. Every single one.
2. **Interpreter matches the proof** - the TypeScript interpreter and TLC produce
   bit-identical state graphs. The code you run is the spec you proved.
3. **Database enforces invariants** - generated Postgres constraints (partial unique
   indexes, CHECK constraints) enforce critical invariants at the storage level,
   closing race conditions no application code can prevent.
4. **Raw writes are blocked** - lint rule catches any code that bypasses the generated
   adapter and writes directly to machine-owned tables.

## Install

```bash
git clone https://github.com/kingbootoshi/tla-precheck.git
cd tla-precheck
bun install
```

Requirements: Bun 1.0+. Java 17+ (for TLC model checking). Set `TLA2TOOLS_JAR` to point
to [tla2tools.jar](https://github.com/tlaplus/tlaplus/releases/latest/download/tla2tools.jar).

## The Design Loop

TLA PreCheck is a design tool, not just a code tool. The design is where the real bugs
live. By the time you're writing code, you've already committed to a design that might
be fundamentally broken.

### For agents (the intended workflow)

```
1. Identify a critical state flow (billing, subscriptions, agent runs...)
2. Write the machine in the DSL
3. Run: bun run estimate (fast budget check, no Java needed)
4. Run: bun run verify (full TLC proof + equivalence check)
5. Model checker finds invariant violation? Fix the DESIGN, not the code
6. Loop until: equivalent: true
7. Run: agent-build (generates adapter + all artifacts from proven machine)
8. Import generated adapter functions from `src/machine-adapters` into your codebase
9. Done. Zero hallucination surface. Proven correct by construction.
```

The agent isn't just coding faster. It's designing better. The model checker sees every
possible future of the system and tells the agent exactly where things break.

### CLI commands

```bash
# Build and typecheck
bun run build
bun run typecheck

# Fast state space estimation (no Java needed, catches budget blowups in seconds)
bun run estimate

# Generate TLA+ artifacts for inspection
bun run generate

# Generate Postgres storage constraints
bun run generate:db

# Lint for raw writes to machine-owned tables
bun run lint

# Run unit and semantic tests
bun run test

# Run differential fuzz tests (randomized compiler testing)
bun run test:fuzz

# Full TLC verification + equivalence proof (requires Java + TLA2TOOLS_JAR)
bun run verify

# Verify all machines across all tiers
bun run verify:all:full

# Verify live Postgres schema matches generated constraints
bun run verify:db

# Agent build: verify + generate adapter in one step
bun dist/cli/machine.js agent-build <compiled-machine.js>
```

### Design principles

- **Target one workflow at a time.** Don't model your entire system. Model the billing
  state machine. Model the subscription lifecycle. One machine per critical flow.
- **Keep domains tiny.** 2 users, 3 runs is enough to find most bugs. Scale proof
  tiers for nightly runs.
- **Verification failure means the design is wrong.** Don't patch around it with code.
  Fix the state machine. Redesign the transitions.
- **Multiple small machines beat one giant spec.** Compose at the application layer,
  prove at the machine layer.

## What It Replaces

| Before | After |
|--------|-------|
| Status columns + scattered if/else | One DSL, generated typed functions |
| "I think these transitions are right" | Mathematical proof across every reachable state |
| Spec and code drift apart over time | One artifact generates both - drift is impossible |
| Agent writes spec AND code (two hallucination surfaces) | Agent writes DSL only, compiler generates the rest |
| Manual DB constraints you hope match the logic | Generated Postgres DDL from the same machine |
| Pray your concurrent transitions don't race | Transactional adapter with row locking + DB constraints |

## How the Proof Works

The DSL is intentionally restricted to 13 expression kinds. Every expression has exactly
one translation to TLA+ and exactly one evaluation in TypeScript. This restriction is
what makes equivalence provable.

The compiler generates both a TLA+ spec and a TypeScript interpreter from the same DSL.
TLC (the TLA+ model checker) exhaustively explores every reachable state of the spec.
The interpreter does the same via breadth-first search. Then the verifier compares both
state graphs and checks they are bit-identical.

If someone introduces a bug in the TLA+ generator, the equivalence check catches it.
If someone introduces a bug in the interpreter, the equivalence check catches it.
The two backends keep each other honest.

The generated adapter doesn't introduce new semantics. It calls the same verified
interpreter inside a database transaction. Load rows, reconstruct state, call `step()`,
diff the result, write changes. The proven interpreter is the runtime.

## Proof Tiers

State explosion is the practical killer of model checking. TLA PreCheck manages this
with bounded proof tiers:

```typescript
proof: {
  defaultTier: "pr",
  tiers: {
    pr: {
      domains: {
        Users: modelValues("u", { size: 2, symmetry: true }),
        Runs: ids({ prefix: "r", size: 3 })
      },
      budgets: { maxEstimatedStates: 10_000 }
    },
    nightly: {
      domains: {
        Users: modelValues("u", { size: 3, symmetry: true }),
        Runs: ids({ prefix: "r", size: 5 })
      },
      budgets: { maxEstimatedStates: 10_000_000 }
    }
  }
}
```

Small tiers run in seconds during PR checks. Larger tiers run nightly.
Budget estimation fails fast before TLC runs, so you don't wait hours
to find out the state space is too large.

## Examples

The repo includes two example machines:

- **Dog** (`src/examples/dog.machine.ts`) - minimal teaching example. 3 modes, 2 tempers,
  6 type-possible states, only 4 reachable. Shows the difference between "what the types
  allow" and "what the system can actually reach."

- **AgentRuns** (`src/examples/agentRuns.machine.ts`) - production-grade. Models distributed
  agent execution with concurrent create/cancel/complete/fail/sweep transitions, a
  one-active-per-user invariant, and storage constraints. 29 million states checked in
  under 3 minutes.

## Further Reading

- [Technical Reference](docs/TECHNICAL-REFERENCE.md) - full DSL reference, CI integration,
  proof tiers, storage backend, testing strategy
- [Problem Statement](PROBLEM.md) - why this exists, the north star

---

<p align="center">MIT License</p>
