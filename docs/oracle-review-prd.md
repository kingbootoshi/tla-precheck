# Oracle Review PRD

You are reviewing a TypeScript/TLA+/Postgres verification compiler. You have the full codebase.

Read these first and treat them as the anchor:
- `THE_PROBLEM.md`
- `docs/compiler-truthfulness.md`
- `docs/compiler-truthfulness-tasks.md`

Do not answer as a general advisor. Answer as if you are producing one final execution-grade review for Codex to follow.

The intent is to solve the problem in `THE_PROBLEM.md`:
- eliminate the hallucination surface between state-machine design and implementation
- make the strongest honest bounded guarantee possible in CI
- keep the infrastructure KISS simple

This must be one integrated answer. Do not split the work into follow-up prompts. Do not ask questions back. Make reasonable assumptions from the repo.

## Current implementation slice to review

The repo has already implemented these changes and you should inspect the code directly rather than trust this summary:

1. Machine validation:
- central `validateMachine()` pass
- stable validation codes
- validation wired into proof resolution, TLA generation, DB generation, and CLI entrypoints

2. Interpreter semantics:
- simultaneous-assignment fix
- repeated writes rejected in validation

3. Literal hardening:
- composite `lit()` values rejected
- reserved sentinel and model-value collisions rejected

4. Storage verification:
- row-predicate semantic evaluation added
- live Postgres schema verification now checks actual predicate semantics, not just object presence and hash comments
- sabotage tests added for wrong predicate and wrong index flags

5. Coverage expansion:
- machine discovery added
- `verify-all`
- `verify-db-all`
- `--all-tiers`
- PR CI widened from one example to all discovered machines
- nightly CI added for full tiers and heavier verification
- TLC pinned to a specific version and SHA256 in CI

6. Parser hardening discovered through real runs:
- TLC DOT parser now handles multiline map labels
- TLC DOT parser now handles scalar state labels that omit the `/\\` prefix

7. Current local status:
- lint passes
- tests pass
- build passes
- `verify-db-all` passes
- `verify-all` passes on pinned TLC
- `verify:all:full` passes on pinned TLC
- seeded fuzz smoke passes

## What I want from you

### Section 1: Blunt assessment
- Start with a short blunt assessment of whether the current implementation materially advances the repo toward solving `THE_PROBLEM.md`.
- Be explicit about what is now genuinely stronger versus what is still overstated.

### Section 2: Explain what was done and why it matters
- Explain the purpose of the implemented changes in terms of the north-star problem.
- Map each implemented slice to the trust boundary it hardens:
  - front end / validator
  - interpreter semantics
  - TLA translation-validation path
  - storage backend
  - CI coverage
- Tell me whether each change is the right kind of simplification or whether any part drifted into unnecessary complexity.

### Section 3: Check the work technically
- Review the implementation directly in the codebase.
- Identify anything that is still wrong, weak, misleading, or over-trusting.
- Prioritize findings by severity.
- Focus on:
  - semantic correctness
  - truthful-compiler claims
  - DB verification honesty
  - parser/comparator trust
  - CI claim surface vs actual checked surface
  - KISS violations

### Section 4: State exactly what the current repo can honestly claim now
- Write the strongest honest claim the repo can make today after these changes.
- Then write the claim it still cannot make.
- Keep this precise. No marketing language.

### Section 5: State exactly what is still missing to solve `THE_PROBLEM.md`
- Use the actual north-star problem, not a generic compiler-quality framing.
- Distinguish:
  - remaining engineering work
  - remaining testing work
  - remaining proof obligations
  - remaining runtime-boundary gaps
- Be explicit about whether the missing generated adapter layer is still the main product gap or whether some compiler-truthfulness gap is still more urgent.

### Section 6: Give Codex a single next-step plan
- Give one prioritized implementation sequence for Codex to execute next.
- Keep it KISS simple.
- No more than 10 steps.
- Prefer the smallest changes that materially reduce remaining trust.
- Do not repeat already-completed work unless you think it is flawed and must be redone.

## Important constraints

- Treat this as a compiler-review and truth-boundary review, not a product brainstorm.
- Do not ask for more prompts or more context.
- Do not produce multiple alternative plans.
- Do not recommend heavy new frameworks unless they are clearly necessary.
- Assume the answer will be handed directly back to Codex for execution.
- Be direct and technical.
- If you think any current README or repo claim is still too strong, say so explicitly.
- If you think the current implementation is on the right track, say exactly why.

## Deliverable format

Use exactly these sections:

1. Blunt assessment
2. What changed and why it matters
3. Technical review of the implementation
4. Strongest honest claim now
5. What is still missing to solve the problem
6. Single next-step plan for Codex

End with:
- a short list called `Do Not Loop On This`
- this list should name the few things Codex should not re-litigate unless a concrete bug is found
