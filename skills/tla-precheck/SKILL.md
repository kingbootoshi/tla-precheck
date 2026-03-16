---
name: tla-precheck
description: Design and verify state machines using the TLA PreCheck TypeScript DSL. Use when building billing flows, subscription lifecycles, agent orchestration, queue processing, deployment pipelines, or any critical state machine where a bug means corrupted data, stuck users, or silent failures. Triggers on .machine.ts files, state machine design tasks, or when formal verification of state transitions is needed.
---

# TLA PreCheck

## What This Is

TLA PreCheck is a restricted TypeScript DSL with TLA+ semantics.

You write machines in `.machine.ts` files. You do NOT write `.tla` files.

The compiler generates:
- TLA+ spec for TLC model checking (exhaustive proof)
- TypeScript interpreter for runtime execution
- Postgres DDL for database-level enforcement
- Generated adapter with typed per-action functions

The key guarantee: for a chosen finite proof tier, the generated TLA+ and the generated TypeScript interpreter reach the **same state graph**. Not similar - identical. Mathematically verified.

Think in TLA+, write in TypeScript.

## Design Rules

1. **One risky workflow per machine.** Don't model your whole system. Model the billing state machine. Model the subscription lifecycle. One machine per critical flow.
2. **Keep proof domains tiny.** 2 users, 3 runs finds most bugs. Scale up in nightly tiers.
3. **Fix the design, not the code.** If `check` fails, the state machine design is wrong. Redesign the transitions and invariants.
4. **Never edit generated artifacts.** Don't touch `.tla` files, certificates, or adapter code. Regenerate with `build`.
5. **Never write directly to machine-owned tables.** All mutations go through the generated adapter or interpreter.
6. **Prefer small atomic machines.** Multiple small machines composed at the application layer beat one giant spec.

## The Three Commands

```bash
# 1. Start a new machine
npx tla-precheck init

# 2. Design loop - run until it passes
npx tla-precheck check <machine>

# 3. Ship it - generates adapter + all artifacts for adapter-capable machines
npx tla-precheck build <machine>
```

**The design loop:**
1. Write/edit the `.machine.ts` DSL
2. Run `check` - it validates, estimates state space, then runs TLC
3. If the model checker finds a bug (invariant violation, stuck state), it tells you exactly what sequence of events caused it
4. Fix the DSL - not a code patch, a design fix
5. Repeat until `check` passes
6. If the machine declares `metadata.runtimeAdapter`, `metadata.ownedTables`, and `metadata.ownedColumns`, run `build` to generate the adapter and all artifacts
7. Import the generated adapter functions into your codebase

## DSL Quick Reference

Machines have **variables**, **actions**, **invariants**, and **proof tiers**.
If you want `build` to generate a database adapter, the machine also needs adapter metadata.

### Variables
```typescript
// Scalar: one value
status: scalarVar(enumType("draft", "active", "done"), lit("draft"))

// Map: one value per domain element (like a column per row)
status: mapVar("Runs", enumType("idle", "running", "done"), lit("idle"))
owner: mapVar("Runs", optionType(domainType("Users")), lit(null))
```

### Actions
```typescript
activate: {
  params: { r: "Runs" },                          // bound parameters
  guard: eq(index(status, param("r")), lit("idle")), // when is this allowed?
  updates: [setMap("status", param("r"), lit("running"))]  // what changes?
}
```

### Invariants
```typescript
oneActivePerUser: {
  description: "At most one running item per user",
  formula: forall("Users", "u", lte(
    count("Runs", "c", and(
      eq(index(owner, param("c")), param("u")),
      eq(index(status, param("c")), lit("running"))
    )),
    lit(1)
  ))
}
```

### Proof Tiers
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
    }
  }
}
```

For the full DSL reference, see `references/dsl-cheatsheet.md`.
For the complete CLI workflow, see `references/cli-workflow.md`.

## What "Done" Means

The machine is verified when:
1. `check` passes - TLC exhaustively explored every reachable state
2. The equivalence certificate says `equivalent: true`
3. `build` succeeds - adapter generated from the proven machine when adapter metadata is declared

After `build`, your codebase imports typed functions:
```typescript
import { create, cancel, complete } from "./machine-adapters/MyMachine.adapter";
await create(sql, { u: userId, r: runId });
```

Each function opens a transaction, locks rows, runs the proven interpreter, diffs state, and writes changes. No hand-written guard logic. No hallucination surface.

## Runtime Boundary

- The interpreter IS the runtime semantics - not an advisory check
- The generated adapter is the preferred mutation path when the machine fits the adapter subset (single owned table, all mapVars, one row domain)
- `build` requires explicit database mapping metadata:
  - `metadata.runtimeAdapter`
  - `metadata.ownedTables`
  - `metadata.ownedColumns`
- If the adapter subset doesn't fit, call the interpreter manually via `step()`
- Storage constraints (Postgres partial unique indexes, CHECK constraints) back cross-row invariants at the database level
