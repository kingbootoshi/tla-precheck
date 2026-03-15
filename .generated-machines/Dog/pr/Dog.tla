---- MODULE Dog ----
EXTENDS FiniteSets, Integers, TLC

\* Generated. Treat as a build artifact.
Null == "__NULL__"


VARIABLES mode, temper

vars == <<mode, temper>>

TypeOK ==
  /\ mode \in {"sleeping", "awake", "eating"}
  /\ temper \in {"calm", "angry"}

sleepingDogsAreCalm ==
  ~((mode = "sleeping") /\ (temper = "angry"))
eatingDogsAreCalm ==
  ~((mode = "eating") /\ (temper = "angry"))

wakeUp ==
  /\ mode = "sleeping"
  /\ mode' = "awake"
  /\ UNCHANGED <<temper>>
fallAsleep ==
  /\ (mode = "awake") /\ (temper = "calm")
  /\ mode' = "sleeping"
  /\ UNCHANGED <<temper>>
serveFood ==
  /\ (mode = "awake") /\ (temper = "calm")
  /\ mode' = "eating"
  /\ UNCHANGED <<temper>>
finishEating ==
  /\ mode = "eating"
  /\ mode' = "awake"
  /\ UNCHANGED <<temper>>
annoy ==
  /\ (mode = "awake") /\ (temper = "calm")
  /\ temper' = "angry"
  /\ UNCHANGED <<mode>>
calmDown ==
  /\ temper = "angry"
  /\ temper' = "calm"
  /\ UNCHANGED <<mode>>

Init ==
  /\ mode = "sleeping"
  /\ temper = "calm"

Next ==
  \/ wakeUp
  \/ fallAsleep
  \/ serveFood
  \/ finishEating
  \/ annoy
  \/ calmDown

EquivalenceNext ==
  \/ wakeUp
  \/ fallAsleep
  \/ serveFood
  \/ finishEating
  \/ annoy
  \/ calmDown

Spec == Init /\ [][Next]_vars
EquivalenceSpec == Init /\ [][EquivalenceNext]_vars

====