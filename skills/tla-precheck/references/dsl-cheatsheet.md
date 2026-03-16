# DSL Cheatsheet

## Expression Kinds (13 total)

| Expression | Example | TLA+ Output |
|-----------|---------|-------------|
| Literal | `lit("queued")` | `"queued"` |
| Parameter | `param("r")` | `r` |
| Variable | `variable("status")` | `status` |
| Map index | `index(status, param("r"))` | `status[r]` |
| Finite set | `setOf(lit("queued"), lit("running"))` | `{"queued", "running"}` |
| Equality | `eq(a, b)` | `a = b` |
| Ordering | `lte(a, b)` | `a <= b` |
| Membership | `isin(x, s)` | `x \in s` |
| Boolean AND | `and(a, b, c)` | `a /\ b /\ c` |
| Boolean OR | `or(a, b)` | `a \/ b` |
| Boolean NOT | `not(a)` | `~a` |
| Counting | `count("Domain", "x", predicate)` | `Cardinality({x \in Domain : predicate})` |
| Universal | `forall("Domain", "x", predicate)` | `\A x \in Domain : predicate` |

No other expression forms are allowed. This restriction is what makes equivalence provable.

## Update Kinds (2 total)

| Update | Example | Effect |
|--------|---------|--------|
| Set scalar | `setVar("mode", lit("active"))` | `mode' = "active"` |
| Set map entry | `setMap("status", param("r"), lit("running"))` | `status' = [status EXCEPT ![r] = "running"]` |

## Value Types

| Type | Constructor | Example Values |
|------|------------|----------------|
| Enum | `enumType("a", "b", "c")` | `"a"`, `"b"`, `"c"` |
| Domain | `domainType("Users")` | Model values from proof tier |
| Boolean | `booleanType()` | `true`, `false` |
| Range | `rangeType(0, 10)` | `0`, `1`, ..., `10` |
| Option | `optionType(domainType("Users"))` | `null` or a Users value |
| Union | `unionType(enumType("a"), booleanType())` | `"a"`, `true`, `false` |

## Variable Kinds

```typescript
// Scalar: single value
mode: scalarVar(enumType("sleeping", "awake", "eating"), lit("sleeping"))

// Map: function from domain to codomain (like a DB column)
status: mapVar("Runs", enumType("idle", "queued", "running"), lit("idle"))
```

## Proof Domain Types

```typescript
// Model values: interchangeable (enables symmetry reduction)
Users: modelValues("u", { size: 2, symmetry: true })

// IDs: concrete string identifiers
Runs: ids({ prefix: "r", size: 3 })  // generates "r1", "r2", "r3"

// Explicit values
Statuses: values(["draft", "active"])
```

## Machine Structure

```typescript
import {
  defineMachine, variable, scalarVar, mapVar,
  enumType, domainType, optionType,
  lit, param, eq, lte, and, or, not, isin, count, forall, index,
  setVar, setMap, setOf,
  modelValues, ids
} from "tla-precheck";

const myVar = variable("myVar");

export const myMachine = defineMachine({
  version: 2,
  moduleName: "MyMachine",
  variables: { /* ... */ },
  actions: { /* ... */ },
  invariants: { /* ... */ },
  proof: {
    defaultTier: "pr",
    tiers: { /* ... */ }
  },
  // Optional: metadata for adapter generation and storage constraints
  metadata: {
    ownedTables: ["my_table"],
    ownedColumns: { my_table: ["status", "owner"] },
    runtimeAdapter: {
      schema: "public",
      table: "my_table",
      rowDomain: "Runs",
      keyColumn: "id",
      keySqlType: "bigint"
    }
  }
});

export default myMachine;
```

## Hard Limits

- Graph-equivalence tiers: max 100,000 estimated states, max 10,000 branching
- Proof domains: max 100 values
- Actions: max 4 parameters
- TLC: 4GB heap, auto workers, 60s timeout
- DOT files: max 50MB
