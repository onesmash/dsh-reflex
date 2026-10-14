---
name: semif-decide
description: >
  Run runtime-defined semantic decisions ("semantic ifs") locally with the SemIf CLI
  (`semif-score`): give a local LLM unstructured state + a criterion question + 2-16 typed
  options, and read option probabilities straight from answer-slot logits in one forward
  pass — no text generation, no JSON repair, no external API. Use this skill whenever the
  user wants to judge, route, classify, or gate with a local model (e.g. "does the evidence
  support X?", ticket routing, policy compliance, release/retry gating, customer-message
  triage), mentions SemIf, OpenJev, semif-score, semantic if, option logits, or MLX/GGUF
  Qwen3.5 scoring, asks "can the CLI run model X / quantization Y", needs to set up or
  repair a missing SemIf/MLX environment, or wants private offline LLM decisions on an
  Apple Silicon Mac or a single-CUDA-GPU box — even if they never name the tool.
---

# SemIf: local semantic decisions via `semif-score`

## What this is

SemIf turns a local LLM into a software `if` statement. One JSONL row = one decision:
unstructured `state` + a `question` (the criterion) + 2-16 typed `options`. The scorer
runs ONE forward pass and reads each option's probability directly from the declared
answer-slot logits — nothing is sampled or generated, so there is no answer text to parse
and no JSON to repair. Every output row carries full provenance (model revision, per-file
sha256, prompt hash), which also makes the CLI a trustworthy instrument for answering
"is model X good enough for my decision?".

## Setup (one-time per machine)

Use the bundled scripts so a missing environment is repaired instead of merely
reported. First run the read-only doctor:

```bash
bash scripts/check_env.sh [repo-dir]
```

It exits `0` only when the source, entry point, and selected runtime are usable. A
missing model cache is informational because the first scoring run can download a pinned
checkpoint. If the doctor reports a missing item, run the idempotent setup command:

```bash
bash scripts/setup_env.sh --backend mlx [--repo /path/to/SemIf]
```

`setup_env.sh` reuses `~/SourceCode/SemIf` and any existing `.venv` before doing work.
If no checkout exists, it copies the bundled source to
`~/.cache/semif-decide/SemIf`; it never overwrites an existing path. On Apple Silicon it
installs the SemIf package without the unused Torch/CUDA dependency, then installs the
repo-pinned MLX runtime. This is materially smaller and avoids the common failure mode
where a first-time setup consumes the disk budget before MLX can start. Set
`SEMIF_STATE_ROOT`, `SEMIF_VENV_DIR`, or `SEMIF_PYTHON` when those defaults do not fit
the machine. The script does not delete caches or old results.

Limitations of the bundled copy vs a git clone: it excludes the browser demo
(`webgpu-demo/`, image `assets/`, and `results/raw` checksums), so repo-level
verification like full `pytest -q` (its testpaths include webgpu-demo) and
`benchmarks/verify_published.py` require the real clone — run `pytest -q tests`
against the bundle instead. For the CLI, examples, manifests, and runtime checks, the
bundle is complete.

CUDA Linux uses the torch backend and needs exactly ONE visible GPU; pass
`--backend torch` and set `CUDA_VISIBLE_DEVICES=0`. Do not install or upgrade MLX/Torch
manually unless the setup script reports a dependency error: the backend expects the
repo-pinned `mlx==0.32.2` and `mlx-lm` revision.

## Pick a model (verified presets)

| model (`--model`) | `--revision` | size | Metal speed | when to use |
|---|---|---|---|---|
| `mlx-community/Qwen3.5-4B-MLX-4bit` | `32f3e8ecf65426fc3306969496342d504bfa13f3` | 3.0 GB | ~0.33 s/row | **default; quality-first**; better on ambiguous, hedged, or judgment-call rows |
| `mlx-community/Qwen3.5-2B-MLX-4bit` | `93760be4f1f69842a46bc13dbdc0f19e291392a3` | 1.7 GB | ~0.15 s/row | speed fallback; use explicitly when criteria are clear-cut or latency matters |
| `Qwen/Qwen3.5-4B` BF16 (CUDA) | `851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a` | ~8 GB | repo reference | benchmark-grade comparisons |

For any other HF repo, resolve the pin yourself: `scripts/pin_revision.sh <org/repo>`
prints the current 40-char commit. Remote loads REQUIRE it — the loader rejects `main`.

Rough quality ladder from the repo's published runs (balanced accuracy): 2B ≈ 0.686,
4B ≈ 0.813. Expect the gap to show up exactly on borderline rows.

## Write the decisions file

JSONL, one decision per line. `state` may be a string, object, or array (it is serialized
into the prompt); `options` need 2-16 entries with unique `id`s.

```json
{"id":"merge-gate","state":"CI 构建日志：真机编译通过，警告 0 新增，单元测试 1428/1428 通过。","question":"证据是否支持\"本次构建可以提交合码审批\"？","options":[{"id":"yes","description":"支持，可提交合码审批。"},{"id":"no","description":"不支持，存在阻塞问题。"},{"id":"insufficient","description":"证据不足以判断。"}]}
```

Design tips that measurably matter:

- When `insufficient` is an option, spell the decision rule out inside `question` (e.g.
  "仅当存在明确阻塞问题时选 no，否则若证据缺失选 insufficient"). Small models hedge to
  `insufficient` when the rule is implicit.
- Keep options mutually exclusive and order-neutral; descriptions carry the semantics.
- Probabilities are **conditional on the option set you supply, not calibrated
  confidence**. Say so in anything you ship onward, and validate on your own workload.

## Run

Prefer the wrapper: it prepares/reuses the environment, selects the verified cached 4B
MLX preset first, falls back to 2B only when 4B is unavailable, rejects unpinned remote
revisions, runs into a temporary file, checks every result row, and only then commits the
final JSONL and a Markdown summary. This prevents a failed partial run from consuming the
requested output path:

```bash
bash scripts/run_score.sh \
  --input decisions.jsonl \
  --output results-<name>.jsonl \
  --offline                 # omit only when a first-run model download is intended
```

The wrapper emits
`RESULT=...`, `SUMMARY=...`, `MODEL=...`, and `REVISION=...` after validation. Both output
paths are create-only; choose a new pair for a rerun.

Use `--model mlx-community/Qwen3.5-2B-MLX-4bit` only when lower latency or memory use is
more important than the 4B quality advantage.

For advanced integrations, call the returned `SEMIF_SCORE` from `setup_env.sh` directly
with the pinned command below, then run `scripts/validate_results.py` against the output.

```bash
SEMIF_SCORE=.venv/bin/semif-score
"$SEMIF_SCORE" \
  --mode direct --backend mlx \
  --model mlx-community/Qwen3.5-4B-MLX-4bit \
  --revision 32f3e8ecf65426fc3306969496342d504bfa13f3 \
  --input decisions.jsonl \
  --output results-<name>.jsonl
```

Mode picker: `direct` (default, independent rows) · `serial` (rows share a state prefix →
prefix-cache reuse, several ×) · `shared` (identical state, many criteria → parallel, ~8×
vs fresh) · `reranker` (torch + CUDA only). Quantization: prequantized MLX repos
(`*-4bit`/`*-8bit`) load as-is — NEVER pass `--mlx-bits` for them (hard error);
`--mlx-bits 4|8` exists only to quantize an unquantized source in memory.

## Read results

Each output line: `probabilities` (finite, sum to 1), `option_logits`, per-row timings,
and a `model` block with revision + quantization + per-file sha256. Practical policy:
auto-accept when the argmax probability clears a threshold (0.8 worked well in ad-hoc
tests) and route everything below it to a human. Calibrate that threshold on your own
workload before trusting it in production. The wrapper's validator additionally checks
row count, input/output IDs and option order, finite probabilities, sum-to-one, and
backend/model/revision provenance; `*.summary.md` lists the argmax and probability for
every row without copying the original state into logs.

## Pitfalls (every row verified by a real run)

| error | fix |
|---|---|
| `Remote models require a pinned 40-character revision` | pass the commit sha (`scripts/pin_revision.sh`) |
| `In-memory quantization requires an unquantized source checkpoint` | drop `--mlx-bits` for prequantized repos |
| `MLX backend supports native Qwen3.5 text scoring only` | repo `model_type` must be `qwen3_5` (no custom `model_file`) |
| `Expose exactly one CUDA GPU` | you're on torch without CUDA — use `--backend mlx` on the Mac |
| `Output must be new` | pick a fresh output path |
| doctor exits nonzero / `semif-score` missing | run `scripts/setup_env.sh`; do not call a global command that may use another Python |
| scorer fails after writing some rows | use `scripts/run_score.sh`; it isolates partial output and commits only after validation |
| `--offline` says a preset is not cached | omit `--offline` for the first pinned download, or point `HF_HOME` at an existing cache |
| GGUF / Q4_K_M won't load | GGUF is the browser/wllama track only; the CLI eats HF + MLX safetensors |

## Benchmark-grade claims

Comparable quality numbers only come from the repo's frozen workloads (authored144 /
perturbations108 / TypeSafe-102), and quantized runs must be evaluated separately against
the unquantized MLX baseline. Before making any quality claim, read
[references/benchmark-discipline.md](references/benchmark-discipline.md).
