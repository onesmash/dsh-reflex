#!/usr/bin/env bash
# Idempotently prepare a SemIf runtime. Existing repos, venvs, and packages win.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUNDLED_REPO="$SCRIPT_DIR/../assets/semif"
DEFAULT_STATE_ROOT="${HOME}/.cache/semif-decide"

usage() {
  cat >&2 <<'EOF'
Usage: setup_env.sh [--repo PATH] [--venv PATH] [--backend mlx|torch]

The command is idempotent. It reuses an existing SemIf checkout/venv and only
installs the backend dependencies when the selected runtime is not importable.
It prints SEMIF_REPO, SEMIF_VENV, and SEMIF_SCORE as the final three stdout lines.
EOF
}

log() {
  printf '[semif-setup] %s\n' "$*" >&2
}

fail() {
  printf '[semif-setup] ERROR: %s\n' "$*" >&2
  exit 1
}

repo_is_valid() {
  [ -f "$1/src/semif_phase1/cli.py" ] && [ -f "$1/pyproject.toml" ]
}

canonical_existing_dir() {
  if [ -d "$1" ]; then
    (cd "$1" && pwd -P)
  else
    printf '%s\n' "$1"
  fi
}

repo_arg=""
venv_arg=""
backend_arg=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo)
      [ "$#" -ge 2 ] || fail "--repo needs a path"
      repo_arg="$2"
      shift 2
      ;;
    --venv)
      [ "$#" -ge 2 ] || fail "--venv needs a path"
      venv_arg="$2"
      shift 2
      ;;
    --backend)
      [ "$#" -ge 2 ] || fail "--backend needs mlx or torch"
      backend_arg="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      if [ -z "$repo_arg" ]; then
        repo_arg="$1"
        shift
      else
        fail "unknown argument: $1"
      fi
      ;;
  esac
done

os="$(uname -s 2>/dev/null || echo unknown)"
arch="$(uname -m 2>/dev/null || echo unknown)"
if [ -z "$backend_arg" ]; then
  if [ "$os" = "Darwin" ] && [ "$arch" = "arm64" ]; then
    backend_arg="mlx"
  elif command -v nvidia-smi >/dev/null 2>&1; then
    backend_arg="torch"
  else
    fail "cannot select a backend; this machine is neither macOS arm64 nor CUDA-capable"
  fi
fi
case "$backend_arg" in
  mlx)
    [ "$os" = "Darwin" ] && [ "$arch" = "arm64" ] || fail "MLX requires macOS arm64"
    ;;
  torch)
    ;;
  *)
    fail "unsupported backend '$backend_arg'; choose mlx or torch"
    ;;
esac

if [ -n "$repo_arg" ]; then
  repo_dir="$repo_arg"
elif [ -n "${SEMIF_REPO:-}" ]; then
  repo_dir="$SEMIF_REPO"
elif repo_is_valid "${HOME}/SourceCode/SemIf"; then
  repo_dir="${HOME}/SourceCode/SemIf"
else
  state_root="${SEMIF_STATE_ROOT:-$DEFAULT_STATE_ROOT}"
  bundle_target="$state_root/SemIf"
  if repo_is_valid "$bundle_target"; then
    repo_dir="$bundle_target"
  elif repo_is_valid "$BUNDLED_REPO"; then
    mkdir -p "$state_root"
    if [ -e "$bundle_target" ]; then
      fail "existing SemIf path is incomplete: $bundle_target; pass --repo with a valid checkout"
    fi
    log "copying the bundled SemIf source to $bundle_target"
    cp -R "$BUNDLED_REPO" "$bundle_target"
    repo_dir="$bundle_target"
  else
    fail "no valid SemIf source found"
  fi
fi
repo_dir="$(canonical_existing_dir "$repo_dir")"
repo_is_valid "$repo_dir" || fail "SemIf source is incomplete: $repo_dir"

state_root="${SEMIF_STATE_ROOT:-$DEFAULT_STATE_ROOT}"
if [ -n "$venv_arg" ]; then
  venv_dir="$venv_arg"
elif [ -n "${SEMIF_VENV_DIR:-}" ]; then
  venv_dir="$SEMIF_VENV_DIR"
elif [ -x "$repo_dir/.venv/bin/semif-score" ]; then
  venv_dir="$repo_dir/.venv"
elif [ -x "${HOME}/SourceCode/SemIf/.venv/bin/semif-score" ]; then
  venv_dir="${HOME}/SourceCode/SemIf/.venv"
else
  venv_dir="$state_root/venv"
fi
venv_dir="$(canonical_existing_dir "$venv_dir")"
venv_parent="$(dirname "$venv_dir")"
mkdir -p "$venv_parent"

if [ -e "$venv_dir" ] && [ ! -x "$venv_dir/bin/python" ]; then
  fail "existing venv path is incomplete: $venv_dir; choose another --venv path"
fi

if [ ! -x "$venv_dir/bin/python" ]; then
  # ---- Python 版本选择 ----
  # mlx==0.32.2 只发布 cp310-cp314 wheel（PyPI 无 cp315）；若 PATH 的 python3 是
  # 3.15+（如 Homebrew 新版），跟随它建 venv 必然安装失败且每轮循环重试。
  # 这里把解释器固定到受支持窗口：PATH python3 在窗口内直接用；超窗时优先用
  # uv 的 managed Python（uv venv --python 3.14 自动下载 3.14），否则明确一次性报错。
  mlx_py_min="3.10"
  mlx_py_max="3.14"
  py_version_of() { "$1" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || true; }
  py_ge() { "$1" -c 'import sys; print(int(sys.version_info >= (3, 10)))' 2>/dev/null || echo 0; }
  py_in_mlx_window() {
    [ "$1" = "$mlx_py_min" ] || [ "$1" = "3.11" ] || [ "$1" = "3.12" ] || [ "$1" = "3.13" ] || [ "$1" = "$mlx_py_max" ]
  }

  # 输出形如 "PATH:<路径>" / "UV_PIN:<版本>" / "NEED_PYTHON" / "UNRESOLVABLE" /
  # "TOO_OLD:<版本>" / "EXPLICIT_UNSUPPORTED:<版本>" / "NO_UV_UNSUPPORTED:<版本>"
  resolve_venv_python() {
    local explicit="${SEMIF_PYTHON:-}"
    local candidate="${explicit:-$(command -v python3 || true)}"
    if [ -z "$candidate" ]; then echo "NEED_PYTHON"; return; fi
    local v
    v="$(py_version_of "$candidate")"
    if [ -z "$v" ]; then echo "UNRESOLVABLE"; return; fi
    if [ "$(py_ge "$candidate")" != "1" ]; then echo "TOO_OLD:$v"; return; fi
    if [ "$backend_arg" = "mlx" ] && ! py_in_mlx_window "$v"; then
      if [ -n "$explicit" ]; then echo "EXPLICIT_UNSUPPORTED:$v"
      elif command -v uv >/dev/null 2>&1; then echo "UV_PIN:$mlx_py_max"
      else echo "NO_UV_UNSUPPORTED:$v"
      fi
      return
    fi
    echo "PATH:$candidate"
  }

  # 持久失败标记：同一原因不每轮重试（一次性报错，避免循环刷屏）。
  # resolve 继续走向失败分支时才读它；走入可执行路径即清除（ENV/venv 状态已变化）。
  blocked_marker="$state_root/venv-blocked"
  fail_once() { # $1=原因文案：首轮写 marker 并报错，后续轮只读 marker
    if [ -f "$blocked_marker" ]; then fail "$(cat "$blocked_marker")"; fi
    mkdir -p "$state_root"
    printf '%s' "$1" > "$blocked_marker"
    fail "$1"
  }

  python_bin=""
  uv_py=""
  resolved="$(resolve_venv_python)"
  case "$resolved" in
    NEED_PYTHON)
      fail_once "python3 is required (set SEMIF_PYTHON to a Python 3.10+ interpreter)"
      ;;
    UNRESOLVABLE)
      fail_once "cannot determine Python version of the resolved interpreter; set SEMIF_PYTHON to a working Python 3.10+ interpreter"
      ;;
    TOO_OLD:*)
      fail_once "Python ${resolved#TOO_OLD:} is too old; SemIf requires Python 3.10+"
      ;;
    EXPLICIT_UNSUPPORTED:*)
      v="${resolved#EXPLICIT_UNSUPPORTED:}"
      fail_once "SEMIF_PYTHON points to Python $v, but mlx==0.32.2 only ships wheels for Python 3.10-3.14 (no cp$v wheel). Set SEMIF_PYTHON to a 3.10-3.14 interpreter (e.g. /opt/homebrew/bin/python3.14), or unset it and install uv for an auto-managed 3.14."
      ;;
    UV_PIN:*)
      uv_py="${resolved#UV_PIN:}"
      log "PATH python3 is too new for mlx==0.32.2; creating venv with uv-managed Python $uv_py (uv downloads it automatically)"
      ;;
    NO_UV_UNSUPPORTED:*)
      v="${resolved#NO_UV_UNSUPPORTED:}"
      fail_once "PATH python3 is Python $v, but mlx==0.32.2 only ships wheels for Python 3.10-3.14 (no cp$v wheel). Install uv (uv venv --python 3.14 auto-downloads a supported version) or set SEMIF_PYTHON to a 3.10-3.14 interpreter."
      ;;
    PATH:*)
      python_bin="${resolved#PATH:}"
      ;;
    *)
      fail "internal error: unexpected resolve_venv_python result '$resolved'"
      ;;
  esac

  # 走过的可执行分支（PATH/UV_PIN）表示环境已变化或可恢复：清掉旧的持久失败标记，
  # 让 resolve 级的确定性失败（TOO_OLD/EXPLICIT/NO_UV）可以重新用 fail_once 记账。
  rm -f "$blocked_marker"

  free_kb="$(df -Pk "$venv_parent" | awk 'NR == 2 {print $4}')"
  [ -n "$free_kb" ] || fail "cannot determine free disk space for $venv_parent"
  min_free_mb="${SEMIF_MIN_FREE_MB:-800}"
  if [ "$free_kb" -lt $((min_free_mb * 1024)) ]; then
    fail "only $((free_kb / 1024)) MiB free; need at least ${min_free_mb} MiB to create the runtime (use an existing venv or set SEMIF_STATE_ROOT)"
  fi

  set +e
  if command -v uv >/dev/null 2>&1; then
    log "creating venv with uv at $venv_dir"
    if [ -n "$python_bin" ]; then
      uv venv --python "$python_bin" "$venv_dir" >&2
    else
      uv venv --python "$uv_py" "$venv_dir" >&2
    fi
  else
    log "creating venv with python at $venv_dir"
    "$python_bin" -m venv "$venv_dir" >&2
  fi
  create_rc=$?
  set -e
  if [ "$create_rc" -ne 0 ]; then
    fail "venv creation failed at $venv_dir (see above) — fix the reported error, or set SEMIF_PYTHON to a supported Python and retry"
  fi
fi

venv_python="$venv_dir/bin/python"
score_bin="$venv_dir/bin/semif-score"
[ -x "$venv_python" ] || fail "venv Python is unavailable: $venv_python"
venv_python_ok="$($venv_python -c 'import sys; print(int(sys.version_info >= (3, 10)))')"
[ "$venv_python_ok" = "1" ] || fail "venv Python is too old; SemIf requires Python 3.10+"

install_packages() {
  if command -v uv >/dev/null 2>&1; then
    uv pip install --python "$venv_python" "$@" >&2
  else
    "$venv_python" -m pip install "$@" >&2
  fi
}

runtime_ready=0
if [ -x "$score_bin" ]; then
  if [ "$backend_arg" = "mlx" ]; then
    if "$venv_python" -c 'import mlx, mlx_lm, huggingface_hub, transformers' >/dev/null 2>&1; then
      runtime_ready=1
    fi
  elif "$venv_python" -c 'import torch, transformers' >/dev/null 2>&1; then
    runtime_ready=1
  fi
fi

if [ "$runtime_ready" -eq 0 ]; then
  log "installing SemIf source without pulling an unused backend"
  install_packages --no-deps -e "$repo_dir"
  if [ "$backend_arg" = "mlx" ]; then
    log "installing pinned MLX runtime (no Torch/CUDA dependency)"
    install_packages \
      'mlx==0.32.2' \
      'mlx-lm @ git+https://github.com/ml-explore/mlx-lm.git@a63e24c389382619eb6d9af656e3b46024be217a' \
      'huggingface-hub==1.31.0' \
      'transformers==5.17.0' \
      'tokenizers==0.23.2' \
      'safetensors==0.8.0' \
      'numpy==2.2.6' \
      'sentencepiece==0.2.1' \
      'protobuf==7.36.1'
  else
    log "installing the pinned Torch backend"
    install_packages -e "$repo_dir"
  fi
fi

[ -x "$score_bin" ] || fail "semif-score was not installed in $venv_dir"
"$score_bin" --help >/dev/null 2>&1 || fail "semif-score cannot start from $score_bin"
if [ "$backend_arg" = "mlx" ]; then
  "$venv_python" -c 'import mlx, mlx_lm, huggingface_hub, transformers' >/dev/null 2>&1 || fail "MLX runtime is still not importable; inspect the pip error above"
fi

log "ready: backend=$backend_arg, repo=$repo_dir, venv=$venv_dir"
printf 'SEMIF_REPO=%s\n' "$repo_dir"
printf 'SEMIF_VENV=%s\n' "$venv_dir"
printf 'SEMIF_SCORE=%s\n' "$score_bin"
