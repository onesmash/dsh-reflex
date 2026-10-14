# Benchmark-grade claims with the SemIf repo

Read this before publishing any quality number. Ad-hoc scores on your own rows are fine
for triage, but comparable, auditable claims only come from the repo's frozen workloads.

## The rules

1. **Frozen workloads only.** `benchmarks/data/` pins authored144 (owned), perturbations108
   (owned), and the 102-row TypeSafe selected subset. New rows are new experiments, not
   comparable results.
2. **Create-only outputs.** Every run writes to a fresh path; never overwrite or edit a
   prior result file. In the repo root, `results*.jsonl` is gitignored on purpose.
3. **Quantized ≠ free.** `manifests/mlx-validation.json` policy: evaluate 8-bit and 4-bit
   separately against the **unquantized MLX baseline** at the same pins; never make a
   quantized result pass by relaxing tolerances. Do not assume calibration.
4. **Preserve pins.** Models and revisions come from `manifests/models.json` (e.g.
   `Qwen/Qwen3.5-4B@851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a`, BF16). MLX production
   runtime is pinned too: mlx 0.32.2 + mlx-lm 0.32.0 (commit `a63e24c`).
5. **Validate the repo after changes**: `pytest -q`, then
   `(cd results/raw && sha256sum -c SHA256SUMS)`, then `python benchmarks/verify_published.py`.
6. **Claim boundaries.** Published browser artifacts (GGUF Q4_K_M/Q8_0) were only
   smoke-tested (loads, completes both paths) — their quantized quality is NOT measured.
   Native BF16 CLI scores belong to the BF16 checkpoints alone.

## Where things live

| artifact | path |
|---|---|
| model + role manifest | `manifests/models.json` |
| MLX validation contract | `manifests/mlx-validation.json` |
| frozen datasets | `benchmarks/data/*.jsonl` |
| metric contract | `benchmarks/manifests/metric-contract.json` |
| raw results + checksums | `results/raw/` (verify with SHA256SUMS) |
| method + claim boundaries | `docs/METHOD.md`, `docs/RESULTS.md` |

## Interpreting small ad-hoc batches

If you score a handful of your own rows: report agreement with hand labels plus the exact
pin and command, call it anecdotal, and prefer argmax + a confidence threshold (e.g. 0.8)
with human routing below it over trusting raw probabilities — the README is explicit that
returned probabilities are conditional on the supplied options, not calibrated confidence.
