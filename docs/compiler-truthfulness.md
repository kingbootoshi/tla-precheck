# Compiler Truthfulness Anchor

This repository has a strong verified-instance pipeline. It does not yet have a universally truthful compiler.

The goal of this document is to pin the exact meaning of "truthful compiler", the gaps that block that claim today, and the order in which those gaps need to be closed.

## Truth Boundary

A truthful compiler claim requires four layers:

1. One formal semantics for the DSL.
2. A TypeScript interpreter that implements that semantics.
3. A TLA generator that implements that semantics.
4. A verification pipeline that can detect drift between the interpreter backend, the TLA backend, and the storage backend.

What tests can establish:

- high confidence for concrete machines
- regression detection for the compiler pipeline
- evidence that the trusted base is stable across supported TLC versions

What tests cannot establish by themselves:

- universal correctness for every valid DSL machine
- correctness beyond the finite proof tiers used for TLC exploration

The strongest honest near-term claim is:

- for checked finite proof tiers, the TypeScript interpreter, generated TLA artifacts, and declared storage constraints agree on the tested machines

The stronger end-state claim requires a DSL semantics document plus mechanized proofs or a dramatically reduced trusted base.

## Immediate Soundness Gaps

The highest-risk issues are semantic mismatches or ambiguous DSL programs:

1. The interpreter must use simultaneous assignment semantics.
2. Multiple writes to the same variable in one action must be either rejected or compiled with a single defined meaning.
3. The DSL must reject malformed, ambiguous, or non-translatable machines before generation.
4. Literal encoding must not admit collisions between internal sentinels, model values, and user space.
5. The storage verifier must compare real Postgres predicates, not just existence and comments.

Until those are fixed, a "truthful compiler" claim is not defensible.

## Trusted Base

The trusted base currently includes:

- DSL AST constructors
- machine validation and proof-tier resolution
- TypeScript interpreter
- TLA generator
- TLC invocation strategy
- TLC DOT parser
- graph comparator
- Postgres DDL renderer
- Postgres schema verifier

The goal is not to eliminate all of these immediately. The goal is to:

- make each component simpler and explicit
- add adversarial tests around each component
- pin external tool versions
- reduce silent assumptions

## Required Workstreams

### 1. Semantic Soundness

- fix simultaneous assignment in the interpreter
- reject repeated writes to the same variable in one action
- add regression tests that directly model these cases

### 2. Machine Validation

Add `validateMachine(machine)` and run it from:

- proof resolution
- TLA generation
- DB contract generation
- CLI entrypoints

Validation must reject:

- unknown variable references
- unknown action parameter references
- updates to unknown variables
- map updates on scalar variables
- out-of-domain map key literals where they can be proven statically
- malformed identifiers
- duplicate explicit domain values
- reserved internal encoding collisions
- unsupported composite literals
- unsupported storage references
- repeated writes to the same variable in one action

### 3. Literal and Encoding Hardening

The DSL should treat literals explicitly, not as arbitrary JSON.

Near-term hardening:

- reject object and array literals in machine expressions
- reject the reserved internal null sentinel in user literals, enum values, and proof-domain values
- reject model-value collisions with user literals during equivalence generation

Longer-term direction:

- replace generic `lit(JsonValue)` with explicit literal constructors

### 4. Storage Contract Verification

`verify-db` must verify:

- presence
- validity
- comment/hash
- indexed columns
- actual partial-index predicate
- actual check-constraint expression

This requires canonicalizing the expected predicate and the live Postgres definition into the same normalized form.

### 5. Coverage Expansion

The system should verify all machines and all declared tiers, not just the example machine.

Required capabilities:

- machine discovery
- `verify-all`
- `verify-db-all`
- scheduled larger verification tiers
- default CI for small tiers
- fuzzing in CI

### 6. Adversarial Testing

The suite needs:

- sabotage tests
- mutation-oriented checks
- broader fuzzing
- exhaustive small-machine enumeration

These are compiler tests, not app tests.

## Verification Philosophy

Translation validation remains valuable even after hardening:

- generate TLA for each machine
- explore the machine in the interpreter
- run TLC
- compare reachable graphs

That is the right per-machine guard. It is not, by itself, a proof of universal compiler correctness.

## Completion Standard

This work is done only when:

- semantic mismatches are fixed or rejected
- the machine validator rejects ambiguous programs
- DB verification checks real predicates
- CI verifies all machines and declared tiers
- adversarial testing exists for the compiler core
- the remaining trust boundary is documented precisely

Anything short of that is still useful, but it is not "truthful compiler" territory.
