# The Problem tla-precheck Solves

This is the north star document. Every agent, every contributor, every design decision
references this. If a change doesn't serve this problem, it doesn't belong here.

---

## The Problem

The most critical code in any system is state management for flows where a bug means
corrupted data, stuck users, or silent failures. Billing states. Subscription lifecycles.
Agent orchestration. Queue processing. Deployment pipelines. Anywhere you'd otherwise
have a status column and a bunch of if-checks scattered across services that you pray
are consistent.

These are the flows where:
- Unit tests check individual transitions but can't prove "there is no 35-step sequence
  of events that puts a user in a stuck state"
- Integration tests cover happy paths and a few sad paths but don't exhaustively explore
  every reachable state
- Mocks test what you think happens, not what actually happens
- Code review catches obvious bugs but not emergent interactions between concurrent actors

TLA+ solves the design verification problem. You model the system as a state machine,
and the model checker exhaustively explores every reachable state, every interleaving,
every edge case. It found bugs in Amazon's DynamoDB replication that required a 35-step
error trace to reproduce - "nobody was going to find that in a whiteboard review."

But TLA+ has a fatal practical problem: **the spec and the code are two separate artifacts.**
You write the TLA+ spec. You write the implementation. They start in sync. Then someone
changes one and forgets the other. The proof becomes a lie. Even experienced practitioners
(engineers who used TLA+ on AWS infrastructure) say: "the reason I only use TLA+ on super
high value projects is you end up writing your spec and then using the spec to write all
the asserts in your code/test to make sure they match." Manual. Fragile. Doesn't scale.

With agentic coding, this gets worse. Now an agent writes the TLA+ spec. Another agent
(or the same one) writes the implementation. Both can hallucinate independently. You have
two hallucination surfaces that need to agree, and no programmatic way to verify they do.
The agent says "done, spec and code match" - but you can't trust that claim. That's the
whole problem with hallucination: the agent doesn't know it's wrong.

## What tla-precheck Does

Eliminates the hallucination surface by making it one artifact, not two.

You write the machine once in a restricted TypeScript DSL. The compiler deterministically
generates:
- A TLA+ spec (for exhaustive model checking by TLC)
- A TypeScript interpreter (for runtime execution)
- Postgres DDL (for database-level enforcement)

Then it proves the generated TLA+ and the generated interpreter produce bit-identical
state graphs. Not "similar." Not "probably equivalent." Identical across every reachable
state.

An agent can't hallucinate the spec out of sync with the implementation because the agent
doesn't write both. It writes one thing. The compiler generates the rest. The model
checker verifies it. There is nothing to hallucinate about.

If the model checker finds an invariant violation, the agent gets immediate feedback and
loops on fixing the DSL until all possible bugs are patched. No human in the loop. No
trusting the agent's claim that it's correct. Mathematical proof or build failure.

## Why This Matters for Agentic Systems

The traditional framing is "developer tooling for formal verification." That undersells it.

The real framing: **tla-precheck is infrastructure that makes it impossible for AI agents
to produce incorrect state machine implementations.**

When agents build and maintain systems autonomously:
- They need to design state machines for critical flows
- They need those designs to be provably correct, not "looks right to me"
- They need the implementation to match the design by construction, not by convention
- They need the database to enforce the invariants regardless of application bugs
- They need all of this to be verifiable in CI without human review

tla-precheck is the answer to "can you verify the agent knows what it's doing?" for
state machine design. Not by asking the agent. By proving it mathematically.

## The Guarantee

When the pipeline passes:
1. The state machine design is correct (TLC exhaustively checked every reachable state)
2. The runtime interpreter is equivalent to the proven design (bit-identical state graphs)
3. The generated adapter calls the proven interpreter inside a transaction - no hand-written
   state mutation code, no hallucination surface
4. The database constraints enforce critical invariants at the storage level
5. The lint rule blocks raw writes to machine-owned tables in CI

The entire path from design to database is generated, verified, and enforced.
The agent writes the DSL. Everything downstream is deterministic.

## The North Star

For every critical state flow in the system:

```
Agent writes DSL --> Compiler generates everything --> Model checker proves it -->
CI gates on proof --> Runtime uses generated adapter --> Database enforces invariants
```

No step requires trust. No step allows hallucination. Every step is verifiable.

This is what "adamantite quality" means for state machines: not "we tested it thoroughly"
but "we proved it mathematically and made it impossible to deviate from the proof."
