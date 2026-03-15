You are reviewing and extending a TypeScript/TLA+/Postgres verification compiler.

You have the full codebase. Read it first. Do not start by proposing abstractions. Start by identifying the exact trust boundaries, semantic backends, and current test gaps.

Project shape:
- One restricted DSL is the source of truth
- Backend 1: DSL -> TypeScript interpreter
- Backend 2: DSL -> TLA+ -> TLC
- Backend 3: machine metadata -> Postgres DDL + live schema verifier
- Current guarantees are bounded, explicit, and CI-gated

Your task:
1. Audit the current verification stack as a compiler testing problem, not an app testing problem.
2. Design the strongest practical fuzz-testing strategy for this repo.
3. Produce an implementation plan that is concrete enough to code immediately.
4. Prefer the smallest design that materially increases compiler confidence.
5. If you suggest new helpers or modules, justify each one in terms of reducing trusted surface area or making counterexamples easier to debug.

Non-negotiable design goals:
- Fuzz the compiler, not arbitrary app inputs
- Generate valid bounded DSL machines, not raw JSON nonsense
- Compare semantic outputs across real backends, not mock interpreters
- Preserve reproducibility: deterministic seeds, persisted failing fixtures, minimal counterexample output
- Optimize for debuggability over raw fuzz throughput
- Do not weaken existing guarantees or add fallback code paths
- Assume the runtime guarantee must remain honest: bounded equivalence, not magic

What I want from you:

Section 1: Current architecture model
- Describe the trusted and untrusted components
- State exactly what the current tests prove
- State exactly what they do not prove

Section 2: Fuzzing strategy
- Propose the right machine generators
- Define the machine families to generate
- Specify which DSL features each family should exercise
- Specify proof-tier sizes and budgets
- Explain how to keep state spaces small enough for TLC

Section 3: Oracle properties
- Define what each fuzz case must check
- TS graph vs TLC graph equivalence
- Initial-state agreement
- Parameter-binding-sensitive edge agreement
- Storage contract generation and schema verification where appropriate
- Negative/sabotage paths if valuable

Section 4: Counterexample handling
- How to record seed, machine source, generated TLA, TLC output, and certificates
- How to shrink failing machines
- Which shrinking operations are highest ROI

Section 5: Concrete implementation plan
- Exact files to add or modify in this repo
- Exact test entrypoints and scripts
- CI strategy: PR tier vs nightly tier
- Runtime expectations and budgets

Section 6: Hard opinions
- Tell me where this repo is still over-trusting itself
- Tell me what not to build yet
- Tell me the smallest set of changes that would make the biggest difference

Constraints:
- Be specific and technical
- Prefer simple code over framework-heavy property-testing libraries unless there is a clear reason not to
- Do not assume external services beyond what the repo already uses
- If a proposal depends on an unfamiliar API, cite the exact API surface you are relying on
- If you recommend random generation, define concrete grammars or templates
- If you recommend shrinkers, define the actual shrink steps

Deliverable format:
- Start with a short blunt assessment
- Then give the plan in the six sections above
- End with a prioritized implementation sequence of at most 10 steps
