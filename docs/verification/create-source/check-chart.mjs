#!/usr/bin/env node
// 图表对表：让手画的 statechart 与模型说的是同一件事。
//
// 用法：node check-chart.mjs <chart.mmd> <落地顺序>
//   落地顺序用逗号分隔，取值 config / target / collector
//   例：node check-chart.mjs chart-fixed.mmd config,target,collector
//
// 退出码：0 = 图自洽且顺序对；1 = 有矛盾；2 = 未判定（读不到、解析不出状态、顺序参数不合法）
//
// 它查三件事：
//   ① 状态名说「visible」⇒ 采集器必须已经落盘；说「invisible」⇒ 采集器必须还没落盘。
//      实例：chart-fixed 曾把「config 落盘」之后标成 visible，而采集器最后才落盘——图上说错了话。
//   ② 主线（非死亡、非回滚边）上的落地顺序必须等于命令行给的顺序。
//   ③ 图里的标签只许 ASCII：Mermaid 后端会把非 ASCII 转成数字实体（&#65288;），不报错但会变得看不懂。
//
// 为什么要有它：S1 要求「先画图让人确认转移」，但图是手写的，模型改了图不一定会改。
// 这张检查补的是「人确认」那一站唯一能机器化的部分。

import { readFileSync } from "node:fs";

const OK = 0;
const BAD = 1;
const UNDECIDED = 2;

const FILE_KINDS = ["collector", "target", "config"];
const NON_ASCII = /[^\x00-\x7F]/;

function parse(text) {
  const labels = new Map();
  const edges = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const edge = line.match(/^(\[\*\]|\w+)\s*-->\s*(\w+)\s*(?::\s*(.+))?$/);
    if (edge) {
      edges.push({ from: edge[1], to: edge[2], label: (edge[3] || "").trim() });
      continue;
    }
    const state = line.match(/^(\w+)\s*:\s*(.+)$/);
    if (state) labels.set(state[1], state[2].trim());
  }
  return { labels, edges };
}

function gained(label) {
  if (/collector file lands/i.test(label)) return "collector";
  if (/target file lands/i.test(label)) return "target";
  if (/config files land/i.test(label)) return "config";
  return null;
}

function main(argv) {
  const [file, orderArg] = argv;
  if (!file || !orderArg) {
    console.log(JSON.stringify({ error: "用法：node check-chart.mjs <chart.mmd> <config,target,collector>" }, null, 2));
    return UNDECIDED;
  }
  const order = orderArg.split(",").map((s) => s.trim());
  if (order.some((k) => !FILE_KINDS.includes(k))) {
    console.log(JSON.stringify({ error: `落地顺序只能取 ${FILE_KINDS.join(" / ")}，读到 ${orderArg}` }, null, 2));
    return UNDECIDED;
  }
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    console.log(JSON.stringify({ error: `读不到 ${file}: ${e.message}` }, null, 2));
    return UNDECIDED;
  }
  const { labels, edges } = parse(text);
  if (labels.size === 0) {
    console.log(JSON.stringify({ error: "没解析出任何状态（需要 `s0: 标签` 这种行）" }, null, 2));
    return UNDECIDED;
  }

  const errors = [];

  // ③ ASCII：先查，因为它会让后面两件事的「可读性」失效
  const nonAscii = [...labels].filter(([, l]) => NON_ASCII.test(l)).map(([s, l]) => `${s}: ${l}`);
  for (const e of edges) if (NON_ASCII.test(e.label)) nonAscii.push(`${e.from}->${e.to}: ${e.label}`);
  if (nonAscii.length > 0) {
    errors.push(`标签里有非 ASCII 字符（Mermaid 会转成数字实体）：${nonAscii.slice(0, 3).join(" / ")}`);
  }

  // ① 可见性：从 [*] 出发，按边累积已落盘集合；回滚边把集合清空
  const incoming = new Set(edges.map((e) => e.to));
  const roots = edges.filter((e) => e.from === "[*]").map((e) => e.to);
  if (roots.length === 0) {
    console.log(JSON.stringify({ error: "找不到 [*] --> 起始边" }, null, 2));
    return UNDECIDED;
  }
  const reached = new Map(); // state -> Set<"": Set 的规范串>
  const queue = roots.map((s) => ({ state: s, set: [] }));
  const seen = new Set();
  while (queue.length > 0) {
    const { state, set } = queue.shift();
    const key = `${state}|${set.join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!reached.has(state)) reached.set(state, new Set());
    reached.get(state).add(set.join(","));
    for (const e of edges.filter((x) => x.from === state)) {
      let next = [...set];
      if (/rollback/i.test(e.label)) next = [];
      const g = gained(e.label);
      if (g && !next.includes(g)) next.push(g);
      queue.push({ state: e.to, set: next });
    }
  }

  for (const [state, sets] of reached) {
    const label = labels.get(state) || "";
    const saysVisible = /visible/i.test(label) && !/invisible/i.test(label);
    const saysInvisible = /invisible/i.test(label);
    if (!saysVisible && !saysInvisible) continue;
    for (const setStr of sets) {
      const set = setStr ? setStr.split(",") : [];
      const hasCollector = set.includes("collector");
      if (saysVisible && !hasCollector) {
        errors.push(`${state}「${label}」说 visible，但按边推它到达时采集器还没落盘（已落盘：${set.join("/") || "无"}）`);
      }
      if (saysInvisible && hasCollector) {
        errors.push(`${state}「${label}」说 invisible，但按边推它到达时采集器已落盘`);
      }
    }
  }

  // ② 顺序：沿主线（落地边）走，落地序列必须等于给定顺序
  const mainPath = [];
  let cur = roots[0];
  const guard = new Set();
  while (cur && !guard.has(cur)) {
    guard.add(cur);
    const outs = edges.filter((e) => e.from === cur);
    const land = outs.find((e) => gained(e.label));
    if (land) {
      mainPath.push(gained(land.label));
      cur = land.to;
      continue;
    }
    // 还没到落地边：沿「非死亡、非回滚」的那条继续走（如「you press create」）
    const next = outs.find((e) => !/killed|rollback|dies/i.test(e.label));
    if (!next) break;
    cur = next.to;
  }
  if (mainPath.join(",") !== order.join(",")) {
    errors.push(`主线的落地顺序是 [${mainPath.join(" → ")}]，期望 [${order.join(" → ")}]`);
  }

  const verdict = errors.length > 0 ? "FAIL" : "OK";
  console.log(JSON.stringify({
    file,
    verdict,
    states: labels.size,
    mainPath,
    errors,
  }, null, 2));
  return verdict === "OK" ? OK : BAD;
}

process.exit(main(process.argv.slice(2)));
