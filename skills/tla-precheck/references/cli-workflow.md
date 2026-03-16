# CLI Workflow

## Installation

```bash
npm install -D tla-precheck    # or: bun add -D tla-precheck
npx tla-precheck setup         # install agent skills + TLC
npx tla-precheck doctor        # verify environment
```

Requirements: Node 18+ or Bun 1.0+. Java 17+ for TLC model checking.

## The Design Loop

### 1. Scaffold a new machine

```bash
npx tla-precheck init
# Prompts for a machine name or path, then creates <name>.machine.ts
```

### 2. Edit the machine

Open the `.machine.ts` file. Define:
- **Variables**: the state your machine tracks
- **Actions**: guarded transitions that change state
- **Invariants**: properties that must hold in every reachable state
- **Proof tiers**: bounded domains for model checking

### 3. Check the design

```bash
npx tla-precheck check billing
```

This runs three steps:
1. **Validate** - checks the DSL for structural errors
2. **Estimate** - computes state space size, fails fast if over budget
3. **Verify** - runs TLC to exhaustively explore every reachable state

If TLC finds an invariant violation, it outputs the exact sequence of transitions (error trace) that leads to the bug. Fix the machine design and re-run.

### 4. Build artifacts

```bash
npx tla-precheck build billing
```

This runs `check` first, then generates:
- TLA+ spec and config (for inspection)
- Postgres storage contract (DDL)
- Typed adapter module at `src/machine-adapters/Billing.adapter.ts`

`build` requires explicit database mapping metadata in the machine:
- `metadata.runtimeAdapter`
- `metadata.ownedTables`
- `metadata.ownedColumns`

Without that metadata, `check` can still pass but `build` will stop at adapter generation and show the metadata shape to add.

### 5. Import and use

```typescript
import { activate, cancel } from "./machine-adapters/Billing.adapter";

// Each function: opens transaction, locks rows, runs proven interpreter,
// diffs state, writes changes. Throws if transition is invalid.
await activate(sql, { r: runId });
await cancel(sql, { r: runId });
```

## Advanced Commands

### Fast estimation (no Java needed)
```bash
npx tla-precheck estimate billing.machine.ts
npx tla-precheck estimate billing.machine.ts --tier nightly
```

### Generate TLA+ for inspection
```bash
npx tla-precheck generate billing.machine.ts
```

### Generate Postgres constraints
```bash
npx tla-precheck generate-db billing.machine.ts
```

### Verify live database schema
```bash
bunx tla-precheck verify-db billing
```
Requires `DATABASE_URL` env var. Bun runtime only.

### Verify all machines in a directory
```bash
npx tla-precheck verify-all dist/
npx tla-precheck verify-all dist/ --all-tiers
```

### Lint for raw writes
```bash
npx tla-precheck lint billing
npx tla-precheck lint-all src/
```

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `TLA2TOOLS_JAR` | Path to tla2tools.jar (TLC model checker) |
| `DATABASE_URL` | Postgres connection string for verify-db |
| `FUZZ_SEED` | Deterministic seed for fuzz tests |
| `FUZZ_CASES` | Number of fuzz test cases |

## CI Integration

```yaml
steps:
  - run: npm install
  - run: npx tla-precheck check src/billing.machine.ts
  - run: npx tla-precheck check src/subscription.machine.ts
```

If any check fails, the build fails. That is the gate.
