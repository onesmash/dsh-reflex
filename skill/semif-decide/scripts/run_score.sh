#!/usr/bin/env bash
# Prepare SemIf, run one create-only score, and validate/commit its output atomically.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VALIDATOR="$SCRIPT_DIR/validate_results.py"

usage() {
  cat >&2 <<'EOF'
Usage: run_score.sh --input PATH --output PATH [options]

Options:
  --mode direct|serial|shared       default: direct
  --backend mlx|torch               default: platform choice
  --model REPO_OR_PATH              default: cached 4B MLX preset, then 2B fallback
  --revision SHA_OR_LABEL           required for custom remote models
  --repo PATH                       SemIf source checkout
  --venv PATH                       existing SemIf venv
  --mlx-bits 4|8                    only for an unquantized MLX source
  --offline                         refuse model downloads
  --summary PATH                    default: output path with .summary.md suffix
EOF
}

fail() {
  printf '[semif-run] ERROR: %s\n' "$*" >&2
  exit 1
}

log() {
  printf '[semif-run] %s\n' "$*" >&2
}

input_path=""
output_path=""
summary_path=""
mode="direct"
backend=""
model=""
revision=""
repo=""
venv=""
mlx_bits=""
offline=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --input)
      [ "$#" -ge 2 ] || fail "--input needs a path"
      input_path="$2"
      shift 2
      ;;
    --output)
      [ "$#" -ge 2 ] || fail "--output needs a path"
      output_path="$2"
      shift 2
      ;;
    --summary)
      [ "$#" -ge 2 ] || fail "--summary needs a path"
      summary_path="$2"
      shift 2
      ;;
    --mode|--backend|--model|--revision|--repo|--venv|--mlx-bits)
      [ "$#" -ge 2 ] || fail "$1 needs a value"
      case "$1" in
        --mode) mode="$2" ;;
        --backend) backend="$2" ;;
        --model) model="$2" ;;
        --revision) revision="$2" ;;
        --repo) repo="$2" ;;
        --venv) venv="$2" ;;
        --mlx-bits) mlx_bits="$2" ;;
      esac
      shift 2
      ;;
    --offline)
      offline=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

[ -n "$input_path" ] || fail "--input is required"
[ -n "$output_path" ] || fail "--output is required"
[ -f "$input_path" ] || fail "input does not exist: $input_path"

if [ -z "$backend" ]; then
  if [ "$(uname -s 2>/dev/null || echo unknown)" = "Darwin" ] && [ "$(uname -m 2>/dev/null || echo unknown)" = "arm64" ]; then
    backend="mlx"
  elif command -v nvidia-smi >/dev/null 2>&1; then
    backend="torch"
  else
    fail "cannot select a backend on this machine"
  fi
fi
case "$backend" in
  mlx|torch) ;;
  *) fail "unsupported backend '$backend'" ;;
esac
case "$mode" in
  direct|serial|shared|reranker) ;;
  *) fail "unsupported mode '$mode'" ;;
esac
if [ "$backend" = "mlx" ] && [ "$mode" = "reranker" ]; then
  fail "MLX does not support reranker mode; use direct, serial, or shared"
fi
if [ -n "$mlx_bits" ] && { [ "$backend" != "mlx" ] || { [ "$mlx_bits" != "4" ] && [ "$mlx_bits" != "8" ]; }; }; then
  fail "--mlx-bits must be 4 or 8 and requires the MLX backend"
fi

setup_args=(--backend "$backend")
[ -n "$repo" ] && setup_args+=(--repo "$repo")
[ -n "$venv" ] && setup_args+=(--venv "$venv")
setup_output="$("$SCRIPT_DIR/setup_env.sh" "${setup_args[@]}")"
while IFS= read -r setup_line; do
  case "$setup_line" in
    SEMIF_REPO=*) repo="${setup_line#SEMIF_REPO=}" ;;
    SEMIF_VENV=*) venv="${setup_line#SEMIF_VENV=}" ;;
    SEMIF_SCORE=*) score_bin="${setup_line#SEMIF_SCORE=}" ;;
  esac
done <<< "$setup_output"
[ -n "${score_bin:-}" ] || fail "setup did not return SEMIF_SCORE"

two_b_model="mlx-community/Qwen3.5-2B-MLX-4bit"
two_b_revision="93760be4f1f69842a46bc13dbdc0f19e291392a3"
four_b_model="mlx-community/Qwen3.5-4B-MLX-4bit"
four_b_revision="32f3e8ecf65426fc3306969496342d504bfa13f3"

cache_has_snapshot() {
  local candidate_model="$1"
  local candidate_revision="$2"
  local cache_root="${HF_HOME:-${HOME}/.cache/huggingface}"
  local model_dir="${cache_root}/hub/models--${candidate_model//\//--}"
  [ -f "$model_dir/snapshots/$candidate_revision/config.json" ]
}

if [ -z "$model" ]; then
  if [ "$backend" = "mlx" ] && cache_has_snapshot "$four_b_model" "$four_b_revision"; then
    model="$four_b_model"
    revision="$four_b_revision"
    log "selected cached quality-first preset: $model@$revision"
  elif [ "$backend" = "mlx" ] && cache_has_snapshot "$two_b_model" "$two_b_revision"; then
    model="$two_b_model"
    revision="$two_b_revision"
    log "4B preset is unavailable; falling back to cached 2B preset: $model@$revision"
  elif [ "$backend" = "mlx" ]; then
    model="$four_b_model"
    revision="$four_b_revision"
    log "no verified MLX preset is cached; the first run may download $model"
  else
    fail "--model is required for the torch backend"
  fi
elif [ -z "$revision" ]; then
  case "$model" in
    "$two_b_model") revision="$two_b_revision" ;;
    "$four_b_model") revision="$four_b_revision" ;;
    */*) fail "custom remote model '$model' needs --revision with a 40-character commit SHA" ;;
    *)
      [ -d "$model" ] || fail "local model path does not exist: $model"
      revision="local"
      ;;
  esac
fi

if [ -d "$model" ]; then
  [ -n "$revision" ] || fail "local model paths still need a nonempty --revision label"
elif ! printf '%s' "$revision" | grep -Eq '^[0-9a-f]{40}$'; then
  fail "remote model revisions must be a pinned 40-character lowercase hex SHA (got '$revision')"
fi
if [ "$offline" -eq 1 ] && [ ! -d "$model" ] && ! cache_has_snapshot "$model" "$revision"; then
  fail "--offline requested, but $model@$revision is not present in the Hugging Face cache"
fi

output_file="$(basename "$output_path")"
output_parent="$(dirname "$output_path")"
[ -n "$output_file" ] && [ "$output_file" != "." ] && [ "$output_file" != ".." ] || fail "invalid output path: $output_path"
mkdir -p "$output_parent"
output_parent="$(cd "$output_parent" && pwd -P)"
output_target="$output_parent/$output_file"
if [ -z "$summary_path" ]; then
  case "$output_file" in
    *.jsonl) summary_file="${output_file%.jsonl}.summary.md" ;;
    *) summary_file="$output_file.summary.md" ;;
  esac
  summary_target="$output_parent/$summary_file"
else
  summary_file="$(basename "$summary_path")"
  summary_parent="$(dirname "$summary_path")"
  mkdir -p "$summary_parent"
  summary_parent="$(cd "$summary_parent" && pwd -P)"
  summary_target="$summary_parent/$summary_file"
fi
[ "$summary_target" != "$output_target" ] || fail "--summary must be different from --output"
[ ! -e "$output_target" ] && [ ! -L "$output_target" ] || fail "output already exists (SemIf is create-only): $output_target"
[ ! -e "$summary_target" ] && [ ! -L "$summary_target" ] || fail "summary already exists: $summary_target"

temp_dir="$(mktemp -d "$output_parent/.semif-run.XXXXXX")"
cleanup() {
  if [ -n "${temp_dir:-}" ] && [ -d "$temp_dir" ]; then
    rm -rf -- "$temp_dir"
  fi
}
trap cleanup EXIT
temp_result="$temp_dir/result.jsonl"
temp_summary="$temp_dir/summary.md"

command_args=(
  "$score_bin"
  --mode "$mode"
  --backend "$backend"
  --model "$model"
  --revision "$revision"
  --input "$input_path"
  --output "$temp_result"
)
[ -n "$mlx_bits" ] && command_args+=(--mlx-bits "$mlx_bits")
log "scoring with $model@$revision ($backend/$mode)"
if [ "$offline" -eq 1 ]; then
  HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 "${command_args[@]}"
else
  "${command_args[@]}"
fi

python_for_validation="$venv/bin/python"
"$python_for_validation" "$VALIDATOR" \
  --input "$input_path" \
  --results "$temp_result" \
  --backend "$backend" \
  --model "$model" \
  --revision "$revision" >/dev/null
mv "$temp_result" "$output_target"
"$python_for_validation" "$VALIDATOR" \
  --input "$input_path" \
  --results "$output_target" \
  --backend "$backend" \
  --model "$model" \
  --revision "$revision" \
  --summary-out "$temp_summary" >/dev/null
mv "$temp_summary" "$summary_target"

log "validated and committed: $output_target"
log "summary: $summary_target"
printf 'RESULT=%s\nSUMMARY=%s\nMODEL=%s\nREVISION=%s\n' \
  "$output_target" "$summary_target" "$model" "$revision"
