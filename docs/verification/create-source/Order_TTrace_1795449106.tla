---- MODULE Order_TTrace_1795449106 ----
EXTENDS Order, Sequences, TLCExt, Toolbox, Naturals, TLC

_expression ==
    LET Order_TEExpression == INSTANCE Order_TEExpression
    IN Order_TEExpression!expression
----

_trace ==
    LET Order_TETrace == INSTANCE Order_TETrace
    IN Order_TETrace!trace
----

_inv ==
    ~(
        TLCGet("level") = Len(_TETrace)
        /\
        committed = ({1})
        /\
        crashed = (FALSE)
        /\
        staged = (TRUE)
    )
----

_init ==
    /\ crashed = _TETrace[1].crashed
    /\ staged = _TETrace[1].staged
    /\ committed = _TETrace[1].committed
----

_next ==
    /\ \E i,j \in DOMAIN _TETrace:
        /\ \/ /\ j = i + 1
              /\ i = TLCGet("level")
        /\ crashed  = _TETrace[i].crashed
        /\ crashed' = _TETrace[j].crashed
        /\ staged  = _TETrace[i].staged
        /\ staged' = _TETrace[j].staged
        /\ committed  = _TETrace[i].committed
        /\ committed' = _TETrace[j].committed

\* Uncomment the ASSUME below to write the states of the error trace
\* to the given file in Json format. Note that you can pass any tuple
\* to `JsonSerialize`. For example, a sub-sequence of _TETrace.
    \* ASSUME
    \*     LET J == INSTANCE Json
    \*         IN J!JsonSerialize("Order_TTrace_1795449106.json", _TETrace)

=============================================================================

 Note that you can extract this module `Order_TEExpression`
  to a dedicated file to reuse `expression` (the module in the 
  dedicated `Order_TEExpression.tla` file takes precedence 
  over the module `Order_TEExpression` below).

---- MODULE Order_TEExpression ----
EXTENDS Order, Sequences, TLCExt, Toolbox, Naturals, TLC

expression == 
    [
        \* To hide variables of the `Order` spec from the error trace,
        \* remove the variables below.  The trace will be written in the order
        \* of the fields of this record.
        crashed |-> crashed
        ,staged |-> staged
        ,committed |-> committed
        
        \* Put additional constant-, state-, and action-level expressions here:
        \* ,_stateNumber |-> _TEPosition
        \* ,_crashedUnchanged |-> crashed = crashed'
        
        \* Format the `crashed` variable as Json value.
        \* ,_crashedJson |->
        \*     LET J == INSTANCE Json
        \*     IN J!ToJson(crashed)
        
        \* Lastly, you may build expressions over arbitrary sets of states by
        \* leveraging the _TETrace operator.  For example, this is how to
        \* count the number of times a spec variable changed up to the current
        \* state in the trace.
        \* ,_crashedModCount |->
        \*     LET F[s \in DOMAIN _TETrace] ==
        \*         IF s = 1 THEN 0
        \*         ELSE IF _TETrace[s].crashed # _TETrace[s-1].crashed
        \*             THEN 1 + F[s-1] ELSE F[s-1]
        \*     IN F[_TEPosition - 1]
    ]

=============================================================================



Parsing and semantic processing can take forever if the trace below is long.
 In this case, it is advised to uncomment the module below to deserialize the
 trace from a generated binary file.

\*
\*---- MODULE Order_TETrace ----
\*EXTENDS Order, IOUtils, TLC
\*
\*trace == IODeserialize("Order_TTrace_1795449106.bin", TRUE)
\*
\*=============================================================================
\*

---- MODULE Order_TETrace ----
EXTENDS Order, TLC

trace == 
    <<
    ([committed |-> {},crashed |-> FALSE,staged |-> FALSE]),
    ([committed |-> {},crashed |-> FALSE,staged |-> TRUE]),
    ([committed |-> {1},crashed |-> FALSE,staged |-> TRUE])
    >>
----


=============================================================================

---- CONFIG Order_TTrace_1795449106 ----
CONSTANTS
    Variant = { "current" }

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
\* Generated on Mon Nov 23 23:51:46 CST 2026