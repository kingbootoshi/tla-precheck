# Compiler Truthfulness Tasks

This is the execution checklist derived from `docs/compiler-truthfulness.md`.

## Current Execution Focus

- [x] Implement `validateMachine()` with stable error codes and tests
- [x] Fix simultaneous-assignment semantics in the interpreter
- [x] Wire validation into proof resolution, generation, DB rendering, and CLI entrypoints
- [x] Harden DB verification to probe live predicate semantics
- [x] Add machine discovery and `verify-all` / `verify-db-all`
- [x] Expand CI from one example machine to all discovered machines and tiers
- [ ] Expand adversarial testing beyond the current seeded differential fuzz harness

## Phase 1 - Semantic Soundness

- [x] Fix interpreter updates to evaluate every RHS against the pre-state.
- [x] Add a simultaneous-assignment regression test.
- [x] Reject repeated writes to the same variable in one action.
- [x] Add tests proving repeated writes fail validation.

## Phase 2 - Machine Validation

- [x] Add `validateMachine(machine)` to the core.
- [x] Validate module, variable, action, parameter, and domain identifiers.
- [x] Validate expression closure: no unknown vars, params, or domains.
- [x] Validate update targets and map/scalar shape.
- [x] Validate duplicate explicit domain values.
- [x] Validate reserved sentinel collisions.
- [x] Validate storage constraint references.
- [x] Run validation from proof resolution, generation, DB rendering, and CLI paths.

## Phase 3 - Literal Hardening

- [x] Reject composite `lit()` values until explicit literal constructors exist.
- [x] Add tests proving arrays and objects are rejected.
- [x] Reject equivalence-time model-value collisions with user literals.

## Phase 4 - Storage Verification

- [x] Extend DB verification results to report predicate and flag matches.
- [x] Introspect real partial-index predicates from Postgres.
- [x] Introspect real check-constraint definitions from Postgres.
- [x] Compare live predicate semantics against DSL predicates with witness rows.
- [x] Add sabotage tests where comments match but predicates or flags are wrong.

## Phase 5 - Coverage Expansion

- [x] Add machine discovery for compiled machine modules.
- [x] Add `verify-all`.
- [x] Add `verify-db-all`.
- [x] Update scripts to use discovery instead of hardcoded examples.
- [x] Update CI to verify all machines and declared tiers.

## Phase 6 - Adversarial Testing

- [ ] Expand fuzz coverage to stress validator failures and edge semantics.
- [ ] Add exhaustive small-machine enumeration for a bounded DSL fragment.
- [ ] Add sabotage fixtures for interpreter/generator/parser/comparator/storage verifier drift.

## Exit Conditions

- [ ] Lint passes.
- [ ] Test suite passes.
- [ ] Build passes.
- [x] `verify-all` passes on supported TLC versions.
- [x] `verify-db-all` passes.
- [ ] Remaining non-universal trust boundary is documented in the README.
