# Technical Reference

Deep technical detail on the compiler, verification pipeline, DSL, and adapter.
For the high-level overview, see the [README](../README.md).

## Architecture

```
               +---> Canonical Interpreter ---> Runtime Execution
               |
Machine DSL ---+---> TLA+ Generator ---------> TLC Model Checker
               |
               +---> Postgres Contract ------> Live Schema Verification
               |
               +---> Graph Comparison -------> Equivalence Certificate
```

Five paths from one source:

1. **Interpreter** - explores every reachable state locally in TypeScript
2. **Estimator** - computes the bounded proof state space and fails fast on budget overruns
3. **Generator** - emits a `.tla` module and tier-specific `.cfg` config
4. **Storage Generator** - emits canonical Postgres DDL plus hash-stamped comments
5. **Comparison** - normalizes both state graphs, checks they are identical

The runtime uses the interpreter directly - not generated guards, not advisory checks. The interpreter IS the runtime. That removes an entire semantic copy and makes the guarantee real.

The TLA+ backend is treated as **untrusted until validated**. `machine verify` always runs TLC once on the real `Spec` proof configuration. On tiers where `graphEquivalence !== false`, it then runs a second TLC pass on `EquivalenceSpec` without symmetry for translation validation against the interpreter graph.

That preserves symmetry for proof runs without corrupting graph-equivalence certificates.

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
- schema verification that proves the live database really has the required constraints

This repo includes semantic unit tests, end-to-end model verification, raw-write boundary checks, schema verification, a live Postgres race test, and seeded compiler differential fuzzing over tiny bounded machines.

There is now a dedicated compiler fuzz harness:
- `bun run test:fuzz`
- deterministic seed via `FUZZ_SEED`
- case count via `FUZZ_CASES`
- generated artifacts under `.generated-machines/fuzz`

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
        graphEquivalence: false,
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
    runtimeAdapter: {
      schema: "public",
      table: "agent_runs",
      rowDomain: "Runs",
      keyColumn: "id",
      keySqlType: "bigint"
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

`graphEquivalence` defaults to `true`. Set `graphEquivalence: false` on larger tiers that should run TLC proof only. This is how large nightly tiers avoid blowing past the TypeScript graph-exploration cap while still proving invariants and properties.

### Hard Safety Limits

The compiler now enforces hard caps in addition to any declared tier budgets:

- graph-equivalence tiers may not declare `maxEstimatedStates > 100_000`
- graph-equivalence tiers may not declare `maxEstimatedBranching > 10_000`
- actual resolved graph-equivalence runs stop before TS exploration if the estimate exceeds `100_000` states or `10_000` branching
- proof domains are capped at `100` values
- actions are capped at `4` parameters
- TLC runs with `java -Xmx4G -jar ... -workers auto`
- TLC proof/equivalence runs time out after `60_000 ms`
- TLC output is truncated after `4 MB`
- TLC metadata directories are capped at `1 GB`
- DOT files above `50 MB` fail verification

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

## Storage Backend

The machine metadata can now declare database constraints that back specific invariants.

For `AgentRuns`, the metadata declares:
- a partial unique index on `agent_runs(owner)` when `status IN ('queued', 'running')`
- a `CHECK` constraint that requires `owner IS NOT NULL` whenever the row is active

That gives you a fourth layer:
- TLA+ proves the invariant in the abstract model
- the interpreter rejects illegal transitions in application code
- the database constraint closes race windows and out-of-band writes
- `machine verify-db` proves the live schema actually has the expected index and check

The storage contract is generated SQL with deterministic hash comments. `verify-db` introspects the live Postgres schema and checks:
- the object exists
- it is valid
- its hash comment matches the machine declaration
- its indexed columns match
- its live predicate semantics match the DSL predicate on witness rows
- its index flags match the expected uniqueness semantics

There is also a destructive integration test that proves the partial unique index behaves correctly under concurrent writes.

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

## Generated Adapter

There is now a generated runtime adapter path for a deliberately narrow subset:

- exactly one owned table
- `metadata.runtimeAdapter` declared
- all machine variables are `mapVar`
- all map vars share one row domain
- variable names match same-named owned SQL columns
- map initial values are primitive literals
- action quantifiers range only over the row domain

The v1 generated adapter locks and loads the whole owned table with one ordered `SELECT ... FOR UPDATE`, reconstructs runtime domains, runs the verified interpreter via `step()`, diffs the resulting map state, and persists the changes inside the same transaction.

That is intentionally conservative. Throughput is not the first goal here. Truthfulness is.

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
    services:
      postgres:
        image: postgres:17
        env:
          POSTGRES_PASSWORD: postgres
          POSTGRES_USER: postgres
          POSTGRES_DB: tla_precheck
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U postgres -d tla_precheck"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    env:
      DATABASE_URL: postgresql://postgres:postgres@localhost:5432/tla_precheck
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
      - run: bun run lint:all
      - run: bun run test
      - run: bun run build
      - run: bun run generate:db

      - name: Apply generated storage contract
        run: |
          bun -e '
            const db = new Bun.SQL(process.env.DATABASE_URL);
            await db.unsafe(`DROP TABLE IF EXISTS public.agent_runs CASCADE;`);
            await db.unsafe(`CREATE TABLE public.agent_runs (id BIGSERIAL PRIMARY KEY, owner TEXT, status TEXT NOT NULL);`);
            await db.close();
            const [{ default: machine }, { applyPostgresStorageContract }] = await Promise.all([
              import("./dist/examples/agentRuns.machine.js"),
              import("./dist/db/postgres.js")
            ]);
            await applyPostgresStorageContract(machine, process.env.DATABASE_URL);
          '

      - run: bun run verify:db
      - run: bun run test:db

      - name: Download TLC
        env:
          TLA2TOOLS_VERSION: v1.8.0
          TLA2TOOLS_SHA256: a89d5ef05d1abddab6acfda1dbace14e2e45e7960527ac186dd19c170a955080
        run: |
          mkdir -p .cache/tla
          curl -L https://github.com/tlaplus/tlaplus/releases/download/${TLA2TOOLS_VERSION}/tla2tools.jar \
            -o .cache/tla/tla2tools.jar
          echo "${TLA2TOOLS_SHA256}  .cache/tla/tla2tools.jar" | shasum -a 256 -c -

      - name: Agent build smoke
        env:
          TLA2TOOLS_JAR: ${{ github.workspace }}/.cache/tla/tla2tools.jar
        run: bun run agent-build

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
  db/
    adapterRuntime.ts  # Shared runtime for generated adapters
    generateAdapter.ts # Generated adapter module writer
    postgres.ts        # Postgres DDL generation and schema verification
  tla/
    generate.ts        # TLA+ module and config generation
    parseDot.ts        # TLC DOT output parser
    compare.ts         # State graph equivalence check
    verify.ts          # TLC proof/equivalence orchestration
  cli/
    machine.ts         # CLI: estimate, generate, generate-db, verify, verify-db, verify-all, verify-db-all, lint-all, agent-build
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
6. The storage certificate says `verified: true`

Then:
- For each checked machine and finite proof tier, every runtime machine step is a step of the checked TLA+ machine
- Proof-only tiers still prove their checked invariants/properties with TLC, but do not claim TS graph equivalence
- Any semantic mismatch between the generator and interpreter is caught for tiers where graph equivalence is actually attempted
- Any missing or drifted storage constraint is caught before deploy for the declared storage contracts
- Safety claims remain bounded by the checked proof model and the machine boundary

## What Is Not Guaranteed

- Arbitrary TypeScript outside the machine boundary
- External API behavior not modeled as state
- Liveness properties (without matching runtime fairness assumptions)
- Unbounded domains beyond the chosen proof model
- Raw-write lint as a complete enforcement proof - it is a guardrail, not a proof

This is a strong checked-instance guarantee. It is not a universal proof for every possible machine or every production system size.

---

See [PROBLEM.md](./PROBLEM.md) for the full motivation and north star.
