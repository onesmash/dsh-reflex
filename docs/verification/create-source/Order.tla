---- MODULE Order ----
\* 创建数据源：五个文件不是一次落盘的。
\*
\* 1 = collectors/<name>.sh   采集器：它一出现在盘上，插件下一轮就当数据源
\* 2 = targets/<name>.sh      判定脚本：没有它，源会一直采集但永远不叫醒
\* 3 = 其余三个配置（collectors/*.env.json、*.schema.json、targets/*.env.json）
\*
\* 落盘顺序用守卫编码，不用序列 —— 两个变体：
\*   Variant = {"current"}  现在的代码：1 → 3 → 2（采集器最先）
\*   Variant = {"fixed"}    修法：3 → 2 → 1（采集器最后，它才是提交点）
CONSTANT Variant

VARIABLES staged, committed, crashed

vars == <<staged, committed, crashed>>

\* 规则：绝不会出现「采集器已在盘上、判定脚本不在」的源
Atomic == (1 \in committed) => (2 \in committed)

Current == "current" \in Variant
Fixed == "fixed" \in Variant

Stage ==
  /\ ~staged
  /\ staged' = TRUE
  /\ UNCHANGED <<committed, crashed>>

Rename1 ==
  /\ staged /\ ~crashed /\ 1 \notin committed
  /\ (Fixed => (2 \in committed /\ 3 \in committed))
  /\ committed' = committed \cup {1}
  /\ UNCHANGED <<staged, crashed>>

Rename3 ==
  /\ staged /\ ~crashed /\ 3 \notin committed
  /\ (Current => 1 \in committed)
  /\ committed' = committed \cup {3}
  /\ UNCHANGED <<staged, crashed>>

Rename2 ==
  /\ staged /\ ~crashed /\ 2 \notin committed
  /\ 3 \in committed
  /\ (Current => 3 \in committed)
  /\ committed' = committed \cup {2}
  /\ UNCHANGED <<staged, crashed>>

\* 进程被杀：清理代码跑不了，写到哪算哪
Crash ==
  /\ ~crashed
  /\ crashed' = TRUE
  /\ UNCHANGED <<staged, committed>>

\* 写盘抛异常：catch 里回滚（只有进程还活着才能跑）
Abort ==
  /\ ~crashed /\ staged
  /\ committed # {1, 2, 3}
  /\ committed' = {}
  /\ staged' = FALSE
  /\ UNCHANGED crashed

Done ==
  /\ crashed
  /\ UNCHANGED vars

Next == Stage \/ Rename1 \/ Rename2 \/ Rename3 \/ Crash \/ Abort \/ Done

Init == staged = FALSE /\ committed = {} /\ crashed = FALSE

Spec == Init /\ [][Next]_vars
====
