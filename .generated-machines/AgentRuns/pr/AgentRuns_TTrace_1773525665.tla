---- MODULE AgentRuns_TTrace_1773525665 ----
EXTENDS AgentRuns, Sequences, TLCExt, Toolbox, Naturals, TLC, AgentRuns_TEConstants

_expression ==
    LET AgentRuns_TEExpression == INSTANCE AgentRuns_TEExpression
    IN AgentRuns_TEExpression!expression
----

_trace ==
    LET AgentRuns_TETrace == INSTANCE AgentRuns_TETrace
    IN AgentRuns_TETrace!trace
----

_inv ==
    ~(
        TLCGet("level") = Len(_TETrace)
        /\
        owner = ([r1 |-> u1, r2 |-> u2, r3 |-> u1])
        /\
        status = ([r1 |-> "cancelled", r2 |-> "cancelled", r3 |-> "cancelled"])
    )
----

_init ==
    /\ owner = _TETrace[1].owner
    /\ status = _TETrace[1].status
----

_next ==
    /\ \E i,j \in DOMAIN _TETrace:
        /\ \/ /\ j = i + 1
              /\ i = TLCGet("level")
        /\ owner  = _TETrace[i].owner
        /\ owner' = _TETrace[j].owner
        /\ status  = _TETrace[i].status
        /\ status' = _TETrace[j].status

\* Uncomment the ASSUME below to write the states of the error trace
\* to the given file in Json format. Note that you can pass any tuple
\* to `JsonSerialize`. For example, a sub-sequence of _TETrace.
    \* ASSUME
    \*     LET J == INSTANCE Json
    \*         IN J!JsonSerialize("AgentRuns_TTrace_1773525665.json", _TETrace)

=============================================================================

 Note that you can extract this module `AgentRuns_TEExpression`
  to a dedicated file to reuse `expression` (the module in the 
  dedicated `AgentRuns_TEExpression.tla` file takes precedence 
  over the module `AgentRuns_TEExpression` below).

---- MODULE AgentRuns_TEExpression ----
EXTENDS AgentRuns, Sequences, TLCExt, Toolbox, Naturals, TLC, AgentRuns_TEConstants

expression == 
    [
        \* To hide variables of the `AgentRuns` spec from the error trace,
        \* remove the variables below.  The trace will be written in the order
        \* of the fields of this record.
        owner |-> owner
        ,status |-> status
        
        \* Put additional constant-, state-, and action-level expressions here:
        \* ,_stateNumber |-> _TEPosition
        \* ,_ownerUnchanged |-> owner = owner'
        
        \* Format the `owner` variable as Json value.
        \* ,_ownerJson |->
        \*     LET J == INSTANCE Json
        \*     IN J!ToJson(owner)
        
        \* Lastly, you may build expressions over arbitrary sets of states by
        \* leveraging the _TETrace operator.  For example, this is how to
        \* count the number of times a spec variable changed up to the current
        \* state in the trace.
        \* ,_ownerModCount |->
        \*     LET F[s \in DOMAIN _TETrace] ==
        \*         IF s = 1 THEN 0
        \*         ELSE IF _TETrace[s].owner # _TETrace[s-1].owner
        \*             THEN 1 + F[s-1] ELSE F[s-1]
        \*     IN F[_TEPosition - 1]
    ]

=============================================================================



Parsing and semantic processing can take forever if the trace below is long.
 In this case, it is advised to uncomment the module below to deserialize the
 trace from a generated binary file.

\*
\*---- MODULE AgentRuns_TETrace ----
\*EXTENDS AgentRuns, IOUtils, TLC, AgentRuns_TEConstants
\*
\*trace == IODeserialize("AgentRuns_TTrace_1773525665.bin", TRUE)
\*
\*=============================================================================
\*

---- MODULE AgentRuns_TETrace ----
EXTENDS AgentRuns, TLC, AgentRuns_TEConstants

trace == 
    <<
    ([owner |-> [r1 |-> "__NULL__", r2 |-> "__NULL__", r3 |-> "__NULL__"],status |-> [r1 |-> "idle", r2 |-> "idle", r3 |-> "idle"]]),
    ([owner |-> [r1 |-> u1, r2 |-> "__NULL__", r3 |-> "__NULL__"],status |-> [r1 |-> "queued", r2 |-> "idle", r3 |-> "idle"]]),
    ([owner |-> [r1 |-> u1, r2 |-> u2, r3 |-> "__NULL__"],status |-> [r1 |-> "queued", r2 |-> "queued", r3 |-> "idle"]]),
    ([owner |-> [r1 |-> u1, r2 |-> u2, r3 |-> "__NULL__"],status |-> [r1 |-> "cancelled", r2 |-> "queued", r3 |-> "idle"]]),
    ([owner |-> [r1 |-> u1, r2 |-> u2, r3 |-> u1],status |-> [r1 |-> "cancelled", r2 |-> "queued", r3 |-> "queued"]]),
    ([owner |-> [r1 |-> u1, r2 |-> u2, r3 |-> u1],status |-> [r1 |-> "cancelled", r2 |-> "cancelled", r3 |-> "queued"]]),
    ([owner |-> [r1 |-> u1, r2 |-> u2, r3 |-> u1],status |-> [r1 |-> "cancelled", r2 |-> "cancelled", r3 |-> "cancelled"]])
    >>
----


=============================================================================

---- MODULE AgentRuns_TEConstants ----
EXTENDS AgentRuns

CONSTANTS u1, u2

=============================================================================

---- CONFIG AgentRuns_TTrace_1773525665 ----
CONSTANTS
    Users = { u1 , u2 }
    Runs = { "r1" , "r2" , "r3" }
    u1 = u1
    u2 = u2

INVARIANT
    _inv

CHECK_DEADLOCK
    \* CHECK_DEADLOCK off because of PROPERTY or INVARIANT above.
    FALSE

INIT
    _init

NEXT
    _next

CONSTANT
    _TETrace <- _trace

ALIAS
    _expression
=============================================================================
\* Generated on Sat Mar 14 15:01:05 PDT 2026