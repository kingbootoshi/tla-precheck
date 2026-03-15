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

Action_create_1 ==
  /\ (status["r1"] = "idle") /\ (owner["r1"] = Null) /\ (Cardinality({candidate \in Runs : (owner[candidate] = "u1") /\ (status[candidate] \in {"queued", "running"})}) = 0)
  /\ status' = [status EXCEPT !["r1"] = "queued"]
  /\ owner' = [owner EXCEPT !["r1"] = "u1"]
Action_create_2 ==
  /\ (status["r2"] = "idle") /\ (owner["r2"] = Null) /\ (Cardinality({candidate \in Runs : (owner[candidate] = "u1") /\ (status[candidate] \in {"queued", "running"})}) = 0)
  /\ status' = [status EXCEPT !["r2"] = "queued"]
  /\ owner' = [owner EXCEPT !["r2"] = "u1"]
Action_create_3 ==
  /\ (status["r3"] = "idle") /\ (owner["r3"] = Null) /\ (Cardinality({candidate \in Runs : (owner[candidate] = "u1") /\ (status[candidate] \in {"queued", "running"})}) = 0)
  /\ status' = [status EXCEPT !["r3"] = "queued"]
  /\ owner' = [owner EXCEPT !["r3"] = "u1"]
Action_create_4 ==
  /\ (status["r1"] = "idle") /\ (owner["r1"] = Null) /\ (Cardinality({candidate \in Runs : (owner[candidate] = "u2") /\ (status[candidate] \in {"queued", "running"})}) = 0)
  /\ status' = [status EXCEPT !["r1"] = "queued"]
  /\ owner' = [owner EXCEPT !["r1"] = "u2"]
Action_create_5 ==
  /\ (status["r2"] = "idle") /\ (owner["r2"] = Null) /\ (Cardinality({candidate \in Runs : (owner[candidate] = "u2") /\ (status[candidate] \in {"queued", "running"})}) = 0)
  /\ status' = [status EXCEPT !["r2"] = "queued"]
  /\ owner' = [owner EXCEPT !["r2"] = "u2"]
Action_create_6 ==
  /\ (status["r3"] = "idle") /\ (owner["r3"] = Null) /\ (Cardinality({candidate \in Runs : (owner[candidate] = "u2") /\ (status[candidate] \in {"queued", "running"})}) = 0)
  /\ status' = [status EXCEPT !["r3"] = "queued"]
  /\ owner' = [owner EXCEPT !["r3"] = "u2"]
Action_startDirect_1 ==
  /\ status["r1"] = "queued"
  /\ status' = [status EXCEPT !["r1"] = "running"]
  /\ UNCHANGED <<owner>>
Action_startDirect_2 ==
  /\ status["r2"] = "queued"
  /\ status' = [status EXCEPT !["r2"] = "running"]
  /\ UNCHANGED <<owner>>
Action_startDirect_3 ==
  /\ status["r3"] = "queued"
  /\ status' = [status EXCEPT !["r3"] = "running"]
  /\ UNCHANGED <<owner>>
Action_claimBackground_1 ==
  /\ status["r1"] = "queued"
  /\ status' = [status EXCEPT !["r1"] = "running"]
  /\ UNCHANGED <<owner>>
Action_claimBackground_2 ==
  /\ status["r2"] = "queued"
  /\ status' = [status EXCEPT !["r2"] = "running"]
  /\ UNCHANGED <<owner>>
Action_claimBackground_3 ==
  /\ status["r3"] = "queued"
  /\ status' = [status EXCEPT !["r3"] = "running"]
  /\ UNCHANGED <<owner>>
Action_complete_1 ==
  /\ status["r1"] = "running"
  /\ status' = [status EXCEPT !["r1"] = "completed"]
  /\ UNCHANGED <<owner>>
Action_complete_2 ==
  /\ status["r2"] = "running"
  /\ status' = [status EXCEPT !["r2"] = "completed"]
  /\ UNCHANGED <<owner>>
Action_complete_3 ==
  /\ status["r3"] = "running"
  /\ status' = [status EXCEPT !["r3"] = "completed"]
  /\ UNCHANGED <<owner>>
Action_fail_1 ==
  /\ status["r1"] = "running"
  /\ status' = [status EXCEPT !["r1"] = "failed"]
  /\ UNCHANGED <<owner>>
Action_fail_2 ==
  /\ status["r2"] = "running"
  /\ status' = [status EXCEPT !["r2"] = "failed"]
  /\ UNCHANGED <<owner>>
Action_fail_3 ==
  /\ status["r3"] = "running"
  /\ status' = [status EXCEPT !["r3"] = "failed"]
  /\ UNCHANGED <<owner>>
Action_cancel_1 ==
  /\ status["r1"] \in {"queued", "running"}
  /\ status' = [status EXCEPT !["r1"] = "cancelled"]
  /\ UNCHANGED <<owner>>
Action_cancel_2 ==
  /\ status["r2"] \in {"queued", "running"}
  /\ status' = [status EXCEPT !["r2"] = "cancelled"]
  /\ UNCHANGED <<owner>>
Action_cancel_3 ==
  /\ status["r3"] \in {"queued", "running"}
  /\ status' = [status EXCEPT !["r3"] = "cancelled"]
  /\ UNCHANGED <<owner>>
Action_sweepStale_1 ==
  /\ status["r1"] = "running"
  /\ status' = [status EXCEPT !["r1"] = "failed"]
  /\ UNCHANGED <<owner>>
Action_sweepStale_2 ==
  /\ status["r2"] = "running"
  /\ status' = [status EXCEPT !["r2"] = "failed"]
  /\ UNCHANGED <<owner>>
Action_sweepStale_3 ==
  /\ status["r3"] = "running"
  /\ status' = [status EXCEPT !["r3"] = "failed"]
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

EquivalenceNext ==
  \/ Action_create_1
  \/ Action_create_2
  \/ Action_create_3
  \/ Action_create_4
  \/ Action_create_5
  \/ Action_create_6
  \/ Action_startDirect_1
  \/ Action_startDirect_2
  \/ Action_startDirect_3
  \/ Action_claimBackground_1
  \/ Action_claimBackground_2
  \/ Action_claimBackground_3
  \/ Action_complete_1
  \/ Action_complete_2
  \/ Action_complete_3
  \/ Action_fail_1
  \/ Action_fail_2
  \/ Action_fail_3
  \/ Action_cancel_1
  \/ Action_cancel_2
  \/ Action_cancel_3
  \/ Action_sweepStale_1
  \/ Action_sweepStale_2
  \/ Action_sweepStale_3

Spec == Init /\ [][Next]_vars
EquivalenceSpec == Init /\ [][EquivalenceNext]_vars

====