#!/usr/bin/env bash
# Read-only SemIf preflight. It never installs packages, copies files, or downloads models.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUNDLED_REPO="$SCRIPT_DIR/../assets/semif"
ok=0
missing=0
warnings=0

say_ok() {
  echo "  [OK]      $1"
  ok=$((ok + 1))
}

say_missing() {
  echo "  [MISSING] $1"
  missing=$((missing + 1))
}

say_warning() {
  echo "  [WARN]    $1"
  warnings=$((warnings + 1))
}

say_info() {
  echo "  [info]    $1"
}

repo_is_valid() {
  [ -f "$1/src/semif_phase1/cli.py" ] && [ -f "$1/pyproject.toml" ]
}

resolve_repo() {
  if [ -n "${1:-}" ]; then
    REPO_DIR="$1"
    REPO_SOURCE="argument"
  elif [ -n "${SEMIF_REPO:-}" ]; then
    REPO_DIR="$SEMIF_REPO"
    REPO_SOURCE="SEMIF_REPO"
  elif repo_is_valid "${HOME}/SourceCode/SemIf"; then
    REPO_DIR="${HOME}/SourceCode/SemIf"
    REPO_SOURCE="${HOME}/SourceCode/SemIf"
  elif repo_is_valid "$BUNDLED_REPO"; then
    REPO_DIR="$BUNDLED_REPO"
    REPO_SOURCE="bundled copy"
  else
    REPO_DIR="${HOME}/SourceCode/SemIf"
    REPO_SOURCE="default (not present)"
  fi
}

find_score_bin() {
  SCORE_BIN=""
  VENV_DIR=""
  local candidates=()
  if [ -n "${SEMIF_VENV_DIR:-}" ]; then
    candidates+=("$SEMIF_VENV_DIR")
  fi
  candidates+=("$REPO_DIR/.venv")
  if [ "$REPO_DIR" != "${HOME}/SourceCode/SemIf" ]; then
    candidates+=("${HOME}/SourceCode/SemIf/.venv")
  fi
  local candidate
  for candidate in "${candidates[@]}"; do
    if [ -x "$candidate/bin/semif-score" ]; then
      VENV_DIR="$candidate"
      SCORE_BIN="$candidate/bin/semif-score"
      return 0
    fi
  done
  if command -v semif-score >/dev/null 2>&1; then
    SCORE_BIN="$(command -v semif-score)"
    VENV_DIR="$(cd "$(dirname "$SCORE_BIN")/.." && pwd)"
  fi
  return 0
}

cache_has_snapshot() {
  local model="$1"
  local revision="$2"
  local cache_root="${HF_HOME:-${HOME}/.cache/huggingface}"
  local model_dir="${cache_root}/hub/models--${model//\//--}"
  [ -f "$model_dir/snapshots/$revision/config.json" ]
}

resolve_repo "${1:-}"
echo "== SemIf preflight (repo: $REPO_DIR; source: $REPO_SOURCE) =="

if repo_is_valid "$REPO_DIR"; then
  say_ok "SemIf source with CLI at $REPO_DIR/src/semif_phase1/cli.py"
else
  say_missing "SemIf source is incomplete at $REPO_DIR"
  say_info "Run: $SCRIPT_DIR/setup_env.sh${1:+ $1}"
fi

os="$(uname -s 2>/dev/null || echo unknown)"
arch="$(uname -m 2>/dev/null || echo unknown)"
if [ "$os" = "Darwin" ] && [ "$arch" = "arm64" ]; then
  say_ok "Apple Silicon detected; MLX backend is available"
elif command -v nvidia-smi >/dev/null 2>&1; then
  say_ok "NVIDIA CUDA tool detected; torch backend may be available"
else
  say_missing "no supported backend detected (need macOS arm64/MLX or CUDA)"
fi

find_score_bin
if [ -n "$SCORE_BIN" ]; then
  if "$SCORE_BIN" --help >/dev/null 2>&1; then
    say_ok "semif-score: $SCORE_BIN"
  else
    say_missing "semif-score exists but cannot start: $SCORE_BIN"
  fi
else
  say_missing "semif-score entry point"
  say_info "Run: $SCRIPT_DIR/setup_env.sh"
fi

if [ -n "$VENV_DIR" ] && [ -x "$VENV_DIR/bin/python" ]; then
  if [ "$os" = "Darwin" ] && [ "$arch" = "arm64" ]; then
    if "$VENV_DIR/bin/python" -c 'import mlx, mlx_lm, huggingface_hub, transformers' >/dev/null 2>&1; then
      versions="$($VENV_DIR/bin/python -c 'from importlib.metadata import version; print("mlx=" + version("mlx") + ", mlx-lm=" + version("mlx-lm"))' 2>/dev/null || echo 'MLX versions unavailable')"
      say_ok "MLX runtime importable ($versions)"
    else
      say_missing "MLX runtime is not importable in $VENV_DIR"
      say_info "Run: $SCRIPT_DIR/setup_env.sh"
    fi
  elif "$VENV_DIR/bin/python" -c 'import torch; raise SystemExit(0 if torch.cuda.is_available() else 1)' >/dev/null 2>&1; then
    say_ok "torch runtime has a visible CUDA device"
  else
    say_warning "torch is not usable with CUDA in $VENV_DIR"
  fi
fi

if [ "$os" = "Darwin" ] && [ "$arch" = "arm64" ]; then
  four_b_model="mlx-community/Qwen3.5-4B-MLX-4bit"
  four_b_revision="32f3e8ecf65426fc3306969496342d504bfa13f3"
  two_b_model="mlx-community/Qwen3.5-2B-MLX-4bit"
  two_b_revision="93760be4f1f69842a46bc13dbdc0f19e291392a3"
  if cache_has_snapshot "$four_b_model" "$four_b_revision"; then
    say_ok "cached MLX preset: $four_b_model@$four_b_revision"
  else
    say_info "4B MLX preset is not cached; first run may download it"
  fi
  if cache_has_snapshot "$two_b_model" "$two_b_revision"; then
    say_ok "cached MLX fallback: $two_b_model@$two_b_revision"
  else
    say_info "2B MLX fallback is not cached; first run may download it"
  fi
fi

echo "== $ok ok, $missing missing, $warnings warnings =="
if [ "$missing" -gt 0 ]; then
  exit 1
fi
exit 0
