# Oracle Master PRD

Use this file when handing the full codebase to a max-compute oracle model.

The goal is not a generic brainstorm. The goal is to get back one response that is concrete enough for Codex to implement directly while keeping the infrastructure KISS simple.

## Copy-Paste Prompt

```text
You are auditing and planning extensions for a TypeScript/TLA+/Postgres verification compiler. You have the full codebase. Read it first.

Treat this as a compiler correctness and compiler testing problem, not an app testing problem.

Project shape:
- One restricted DSL is the source of truth
- Backend 1: DSL -> TypeScript interpreter
- Backend 2: DSL -> TLA+ -> TLC
- Backend 3: machine metadata -> Postgres DDL + live schema verifier
- Current guarantees are bounded, explicit, and CI-gated

You must optimize for:
- truthfulness of compiler claims
- smallest trusted surface area
- KISS-simple infrastructure
- debuggable counterexamples
- reproducible CI

You must not optimize for:
- framework-heavy fuzz infrastructure
- abstract "future flexibility"
- weakening guarantees to make tests pass
- large-model benchmark theater

Context docs in the repo:
- docs/compiler-truthfulness.md
- docs/compiler-truthfulness-tasks.md

Your task:
1. Audit the current trust boundary and verification stack.
2. Identify the highest-priority semantic soundness gaps.
3. Design the minimum credible `validateMachine()` front-end validation pass.
4. Design the minimum credible hardening for literal/null/model-value encoding safety.
5. Design the minimum credible hardening for Postgres schema verification so it checks actual live semantics, not just comments or presence.
6. Design the strongest practical fuzz-testing and exhaustive-small-case strategy for this repo.
7. Design the minimum CI and toolchain changes needed to make results reproducible and to verify all machines and declared tiers.
8. State exactly what would still be missing after all of that before anyone could honestly claim the compiler is universally truthful for any valid machine.

Non-negotiable design constraints:
- Fuzz the compiler, not arbitrary app inputs
- Generate valid bounded DSL machines, not raw JSON nonsense
- Compare real semantic outputs across real backends
- Preserve reproducibility: deterministic seeds, pinned tool versions, persisted failure artifacts
- Keep state spaces tiny enough for TLC to stay cheap
- Do not introduce fallback code paths or weaken existing checks
- Prefer explicit, small modules over generalized frameworks
- If you suggest a new helper/module, justify it in terms of either:
  - reducing trusted surface area
  - making counterexamples easier to debug
  - removing duplicated verification logic
- If you rely on an unfamiliar API, cite the exact API or catalog surface

Deliverable format:

Section 1: Blunt assessment
- In 5-10 bullets, state what is already good and what is still over-trusting itself.

Section 2: Current trust boundary
- List trusted vs untrusted components.
- State exactly what current tests prove.
- State exactly what they do not prove.

Section 3: Semantic soundness gaps
- Identify concrete interpreter/generator/storage mismatches or ambiguity risks.
- Prioritize them by severity.
- For each one, say whether to:
  - fix implementation semantics
  - reject the machine shape in validation
  - or change the test harness

Section 4: Machine validation design
- Specify the exact validation rules for `validateMachine()`.
- Include identifier checks, closure checks, update-target checks, repeated-write checks, domain checks, reserved-value collisions, and unsupported literal shapes.
- State exactly where validation should be invoked in the repo.

Section 5: Storage verifier hardening
- Specify how to verify actual partial-index predicates and check-constraint definitions.
- Name the exact Postgres catalog/functions you would use.
- Define sabotage cases that must fail.

Section 6: Fuzzing and exhaustive checking strategy
- Define the machine families to generate.
- Specify which DSL features each family should exercise.
- Define proof-tier sizes and state/branching budgets.
- Define oracle properties for each fuzz case.
- Define failure artifact contents and shrink steps.
- Define where exhaustive small-machine enumeration is worth adding and for which bounded DSL fragment.

Section 7: Concrete implementation plan
- Exact files to add or modify in this repo.
- Exact scripts to add or change.
- Exact CI changes for PR vs nightly.
- Keep the implementation plan small and sequential.

Section 8: Remaining truth boundary
- After all proposed engineering work is complete, state the strongest honest claim the repo could make.
- Then state what extra formalization or proof work would still be required for:
  - “truthful for any valid machine in the DSL”
  - “finite proof tiers generalize to arbitrary production sizes”

Section 9: Prioritized execution sequence
- At most 10 steps.
- Each step must be concrete and directly implementable.
- Order the steps so that Codex can execute them with minimal rework.

Important:
- Be specific and technical.
- Do not give vague recommendations.
- Do not default to “use property-based testing library X” unless there is a clear repo-local reason.
- Do not redesign the entire system.
- Assume the implementation should stay KISS simple.
- The response is meant for another coding agent to execute directly.
```

## What To Bring Back

Come back when the oracle response includes all of the following:

- a clear trusted-vs-untrusted boundary
- a concrete semantic unsoundness list
- explicit `validateMachine()` rules
- exact Postgres catalog APIs for verifier hardening
- typed fuzz families with tiny budgets
- shrink steps
- exact files to add or modify
- exact CI changes
- a final statement of the remaining truth boundary

Do not come back with:

- generic brainstorming
- tool recommendations without file-level changes
- vague “add more tests” advice
- large-framework proposals
- anything that weakens current guarantees

## How Codex Will Use It

Codex will treat the oracle response as:

- implementation guidance
- gap confirmation
- a way to reduce missed edge cases

Codex will not treat it as:

- a replacement for repo-local validation
- a proof of correctness
- a reason to add complexity without payoff
