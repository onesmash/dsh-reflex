-------- MODULE Registry --------
\* 「登记表的派生指标必须等于计数算出来的值」的最小模型。
\*
\* 对比两种写协议：
\*   two-step       计数与派生副本分两步写（复制品方案，2026-11-24 之前的形态）
\*   single-source  只写计数，派生在读时现算（单一真值源）
\*
\* 不变量 ReadConsistent：读者从未读到过与计数不符的派生值。
\*
\* 边界（不管的部分）：不建模文件系统原子写、不建模多进程、不建模 JSON 解析、
\* 不建模派生算法本身（TrueRecall 就是真值）。只问一件事：
\* 两步写有没有一个「计数已新、副本仍旧」的可读窗口。
\*
\* 有界化：计数最多变两次（FN0..FN0+2）；"读到过不一致"用布尔锁存，不用无界序列。

EXTENDS Naturals, TLC

CONSTANTS TP0, FP0, FN0, Protocol

VARIABLES tp, fp, fn, copy, sawBad

vars == <<tp, fp, fn, copy, sawBad>>

\* 千分比表示 recall，避免实数
TrueRecall == IF tp + fn = 0 THEN 0 ELSE (1000 * tp) \div (tp + fn)

InitialCopy == IF TP0 + FN0 = 0 THEN 0 ELSE (1000 * TP0) \div (TP0 + FN0)

Init == /\ tp = TP0
        /\ fp = FP0
        /\ fn = FN0
        /\ copy = InitialCopy
        /\ sawBad = FALSE

\* 计数变化：多了一个漏报。最多变两次，保证状态空间有界。
WriteCounts ==
    /\ fn < FN0 + 2
    /\ fn' = fn + 1
    /\ UNCHANGED <<tp, fp, copy, sawBad>>

\* 第二步：把副本同步过来。只有 two-step 协议存在这一动作；
\* single-source 下根本没有这个字段，所以这一步不可达。
SyncCopy ==
    /\ Protocol = "two-step"
    /\ copy' = TrueRecall
    /\ UNCHANGED <<tp, fp, fn, sawBad>>

\* 读者读到一份快照；若与计数不符，锁存 sawBad
Read ==
    LET observed == IF Protocol = "single-source" THEN TrueRecall ELSE copy
        truth    == TrueRecall
        mismatch == observed /= truth
    IN /\ sawBad' = (sawBad \/ mismatch)
       /\ UNCHANGED <<tp, fp, fn, copy>>

Next == \/ WriteCounts \/ SyncCopy \/ Read

Spec == Init /\ [][Next]_vars

TypeOK == /\ tp \in Nat /\ fp \in Nat /\ fn \in Nat
          /\ copy \in Nat
          /\ sawBad \in BOOLEAN

\* 性质：读者从未读到过不一致的派生值
ReadConsistent == ~sawBad

====
