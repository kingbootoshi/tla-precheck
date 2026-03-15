---- MODULE AgentRuns ----
EXTENDS FiniteSets, Integers, TLC

\* Generated. Treat as a build artifact.
Null == "__NULL__"

CONSTANTS Users, Runs

Symmetry == Permutations(Users)

VARIABLES status, owner

vars == <<status, owner>>

TypeOK ==
  /\ status \in [Runs -> {"idle", "queued", "running", "completed", "failed", "cancelled"}]
  /\ owner \in [Runs -> Users \cup {Null}]

oneActivePerUser ==
  \A u \in Users : Cardinality({candidate \in Runs : (owner[candidate] = u) /\ (status[candidate] \in {"queued", "running"})}) <= 1

create(u, r) ==
  /\ u \in Users
  /\ r \in Runs
  /\ (status[r] = "idle") /\ (owner[r] = Null) /\ (Cardinality({candidate \in Runs : (owner[candidate] = u) /\ (status[candidate] \in {"queued", "running"})}) = 0)
  /\ status' = [status EXCEPT ![r] = "queued"]
  /\ owner' = [owner EXCEPT ![r] = u]
startDirect(r) ==
  /\ r \in Runs
  /\ status[r] = "queued"
  /\ status' = [status EXCEPT ![r] = "running"]
  /\ UNCHANGED <<owner>>
claimBackground(r) ==
  /\ r \in Runs
  /\ status[r] = "queued"
  /\ status' = [status EXCEPT ![r] = "running"]
  /\ UNCHANGED <<owner>>
complete(r) ==
  /\ r \in Runs
  /\ status[r] = "running"
  /\ status' = [status EXCEPT ![r] = "completed"]
  /\ UNCHANGED <<owner>>
fail(r) ==
  /\ r \in Runs
  /\ status[r] = "running"
  /\ status' = [status EXCEPT ![r] = "failed"]
  /\ UNCHANGED <<owner>>
cancel(r) ==
  /\ r \in Runs
  /\ status[r] \in {"queued", "running"}
  /\ status' = [status EXCEPT ![r] = "cancelled"]
  /\ UNCHANGED <<owner>>
sweepStale(r) ==
  /\ r \in Runs
  /\ status[r] = "running"
  /\ status' = [status EXCEPT ![r] = "failed"]
  /\ UNCHANGED <<owner>>

Init ==
  /\ status = [x \in Runs |-> "idle"]
  /\ owner = [x \in Runs |-> Null]

Next ==
  \/ \E u \in Users, r \in Runs : create(u, r)
  \/ \E r \in Runs : startDirect(r)
  \/ \E r \in Runs : claimBackground(r)
  \/ \E r \in Runs : complete(r)
  \/ \E r \in Runs : fail(r)
  \/ \E r \in Runs : cancel(r)
  \/ \E r \in Runs : sweepStale(r)

Spec == Init /\ [][Next]_vars

====