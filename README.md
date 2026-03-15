<p align="center">
  <img src="tla-precheck-banner.jpeg" alt="TLA PreCheck" width="100%" />
</p>

<h3 align="center">Your TLA+ spec and your TypeScript code drift apart.<br/>This kit makes that impossible.</h3>

<p align="center">
  <a href="#quickstart">Quickstart</a> -
  <a href="#how-it-works">How It Works</a> -
  <a href="#the-dsl">The DSL</a> -
  <a href="#ci-integration">CI Integration</a> -
  <a href="LICENSE">MIT License</a>
</p>

---

## The Problem

You write a TLA+ spec. You write TypeScript. They start in sync. Then someone changes the code and forgets the spec. Or changes the spec and forgets the code. Now your "formally verified" system is a lie.

**TLA PreCheck** eliminates drift by generating both the TLA+ spec and the runtime interpreter from a single TypeScript DSL. Then it *proves* they produce identical state graphs. Every CI run. Every commit.

If they diverge, your build fails. No drift. No lies.

## Quickstart

```bash
# Install
git clone https://github.com/kingbootoshi/tla-precheck.git
cd tla-precheck
bun install

# Estimate the PR proof tier before TLC ever runs
bun run estimate

# Enforce the raw-write boundary on machine-owned state
bun run lint

# Run the framework and example tests
bun run test

# Generate TLA+ artifacts from the example machine
bun run generate

# Verify the PR tier (requires Java 17+ and TLA2TOOLS_JAR)
bun run verify
```

The verify step produces an equivalence certificate:

```json
{
  "machine": "AgentRuns",
  "tier": "pr",
  "equivalent": true,
  "tsStateCount": 1099,
  "tlcStateCount": 1099,
  "tsEdgeCount": 3696,
  "tlcEdgeCount": 3696
}
```

If `equivalent` is `false`, your build should fail. That is the entire point.

## How It Works

```
               +---> Canonical Interpreter ---> Runtime Execution
               |
Machine DSL ---+---> TLA+ Generator ---------> TLC Model Checker
               |
               +---> Graph Comparison -------> Equivalence Certificate
```

Four paths from one source:

1. **Interpreter** - explores every reachable state locally in TypeScript
2. **Estimator** - computes the bounded proof state space and fails fast on budget overruns
3. **Generator** - emits a `.tla` module and tier-specific `.cfg` config
4. **Comparison** - normalizes both state graphs, checks they are identical

The runtime uses the interpreter directly - not generated guards, not advisory checks. The interpreter IS the runtime. That removes an entire semantic copy and makes the guarantee real.

The TLA+ backend is treated as **untrusted until validated**. `machine verify` runs TLC twice:
- once with the tier’s real config for the actual proof run
- once without symmetry for translation validation against the interpreter graph

That preserves symmetry for safety tiers without corrupting the equivalence certificate.

## Testing This Like a Compiler

Treat this as a dual-backend compiler problem, not a normal application test problem.

The strongest honest claim is:
- for a chosen finite proof tier, the interpreter and TLC reach the same state graph
- production mutates machine-owned state only through the interpreter
- database constraints close race windows for cross-row invariants

The required test stack is:
- semantic unit tests for the interpreter, generator, DOT parser, graph comparison, and boundary lint
- end-to-end verification for each real machine and proof tier
- sabotage tests that intentionally break one side and prove verification fails
- randomized differential tests over many tiny generated machines
- boundary tests that prove raw writes are rejected outside the generated adapter path

This repo includes the first, second, and fifth layers directly. The next highest-value addition is randomized differential testing over many tiny bounded machines.

## The DSL

The DSL is intentionally restricted. No arbitrary JavaScript. No closures. No side effects. Every expression must be translatable to both TLA+ and executable TypeScript.

Here is a real machine that models distributed agent execution:

```typescript
import { defineMachine, variable, mapVar, enumType, /* ... */ } from "tla-precheck";

const status = variable("status");
const owner = variable("owner");

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
    // ... complete, fail, cancel, sweepStale
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
  }
});
```

This single definition generates:
- A TLA+ module that TLC can model check
- A canonical interpreter that your runtime calls directly
- A tier-aware estimate that exposes state-space blowups before TLC
- An equivalence certificate proving they agree on every reachable state

### Allowed Expressions

| Expression | Example | TLA+ Output |
|-----------|---------|-------------|
| Literals | `lit("queued")` | `"queued"` |
| Variables | `variable("status")` | `status` |
| Parameters | `param("r")` | `r` |
| Map index | `index(status, param("r"))` | `status[r]` |
| Finite sets | `setOf(lit("queued"), lit("running"))` | `{"queued", "running"}` |
| Equality | `eq(a, b)` | `a = b` |
| Membership | `isin(x, s)` | `x \in s` |
| Boolean ops | `and()`, `or()`, `not()` | `/\`, `\/`, `~` |
| Counting | `count(domain, binder, pred)` | `Cardinality({...})` |
| Quantifiers | `forall(domain, binder, pred)` | `\A binder \in domain : ...` |
| Ordering | `lte(a, b)` | `a <= b` |

No other forms are allowed. That constraint is what makes the equivalence provable.

### Proof Tiers

Every machine must declare bounded proof tiers. That is the hard guard against state explosion.

- `modelValues(prefix, { size, symmetry })` gives TLC a small interchangeable domain
- `ids({ prefix, size })` gives a bounded concrete string domain
- `rangeType(min, max)` replaces unbounded integers
- `optionType(T)` replaces ad hoc `T | null` unions

`machine estimate` computes the implied state count and branching from those proof domains and fails when a tier exceeds its budget.

## Dog Example

The simplest teaching machine is a dog with two variables:
- `mode`: `sleeping | awake | eating`
- `temper`: `calm | angry`

This is better than four booleans because `mode` is a mutually exclusive phase machine.

The proof tier has 6 possible typed states:
- `3` values for `mode`
- `2` values for `temper`
- `3 x 2 = 6` total combinations

The transition system only reaches 4 of them:
- `sleeping/calm`
- `awake/calm`
- `eating/calm`
- `awake/angry`

The impossible combinations are:
- `sleeping/angry`
- `eating/angry`

That is exactly the distinction you want users to understand:
- type-possible states
- reachable states
- invariant-forbidden states

See [src/examples/dog.machine.ts](src/examples/dog.machine.ts) and [src/examples/dog.machine.test.ts](src/examples/dog.machine.test.ts) for a minimal scalar-only example.

## Runtime Usage

Route all machine state mutations through the interpreter. Never write to machine-owned state directly.

```typescript
const current = await repo.loadMachineState(userId);
const next = step(agentRunsMachine, current, "cancel", { r: runId });
if (next === null) throw new Error("Transition not enabled");
await repo.commitMachineState(current, next, { action: "cancel", userId, runId });
```

For cross-row invariants, back them with database constraints:

```sql
CREATE UNIQUE INDEX agent_runs_one_active_per_user
ON agent_runs (owner)
WHERE status IN ('queued', 'running');
```

The machine proves the invariant holds in the abstract model. The database constraint enforces it against races that no application-level guard can close.

## CI Integration

```yaml
name: machine-verification
on:
  pull_request:
  push:
    branches: [main]

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: "1.3.8"
      - uses: actions/setup-java@v5
        with:
          distribution: temurin
          java-version: "17"

      - run: bun install
      - run: bun run lint
      - run: bun run test
      - run: bun run build

      - name: Download TLC
        run: |
          mkdir -p .cache/tla
          curl -L https://github.com/tlaplus/tlaplus/releases/latest/download/tla2tools.jar \
            -o .cache/tla/tla2tools.jar

      - name: Verify machines
        env:
          TLA2TOOLS_JAR: ${{ github.workspace }}/.cache/tla/tla2tools.jar
        run: bun run verify

      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: machine-certificates
          path: .generated-machines/**
```

If `equivalent !== true`, the build fails. That is the gate.

## File Layout

```
src/
  core/
    dsl.ts             # Restricted machine DSL
    interpreter.ts     # Canonical runtime semantics
    stable.ts          # Deterministic JSON serialization
  tla/
    generate.ts        # TLA+ module and config generation
    parseDot.ts        # TLC DOT output parser
    compare.ts         # State graph equivalence check
  cli/
    machine.ts         # CLI: estimate, generate, verify
  lint/
    noRawMachineWrites.ts  # Static analysis for boundary violations
  examples/
    agentRuns.machine.ts   # Example: agent run orchestration
```

## What Is Guaranteed

If you follow these rules:

1. Machines are written only in the restricted DSL
2. All writes to machine-owned state go through the interpreter
3. Cross-row invariants are backed by database constraints
4. Side effects are modeled as state (outbox pattern)
5. The equivalence certificate says `true`

Then:
- Every runtime machine step is a step of the verified TLA+ machine
- Every safety invariant proved by TLC holds at runtime
- Any semantic mismatch between the generator and interpreter is caught

## What Is Not Guaranteed

- Arbitrary TypeScript outside the machine boundary
- External API behavior not modeled as state
- Liveness properties (without matching runtime fairness assumptions)
- Unbounded domains beyond the chosen proof model

This is the strongest honest guarantee you can get in a TypeScript codebase without switching to a fully verified implementation language.

## Why This Exists

Nobody is doing formal verification for the TypeScript ecosystem. The Lean/Coq/Isabelle people have their own world. The Go people have PGo. But the engineers building production systems in Node - the people who need guarantees the most - have nothing.

TLA PreCheck fills that gap. Not with academic hand-waving, but with a concrete pipeline: define once, generate both, prove equivalence, gate CI.

If the certificate says `equivalent: true`, your spec and your code agree. If it doesn't, your build breaks before the bug ships.

---

<p align="center">MIT License</p>
