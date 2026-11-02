#!/usr/bin/env python3
"""常驻 SemIf 打分器（随插件分发，由 call.sh 按需拉起）。

为什么存在：run_score.sh 每次调用都要重新付一遍 setup_env 依赖探测、模型加载、
模型文件 sha256 复核。本机实测单次墙钟 ~11.9s，其中前向只占 ~0.60s（5%）。
常驻后模型只加载一次，热调用 ~0.7s。

协议：Unix domain socket，一行 JSON 请求 → 一行 JSON 响应。
  请求 {"input": "/abs/in.jsonl", "output": "/abs/out.jsonl"}
  响应 {"ok": true, "cases": 6, "score_seconds": 3.4, "total_seconds": 0.61}
       {"ok": false, "error": "..."}

语义与 run_score.sh 对齐（失败绝不留半成品）：
  · create-only：output 或 summary 已存在即拒绝，不覆盖
  · 先写临时文件 → 跑 validate_results.py → 校验通过才原子改名
  · 校验器与直调路径同一份，坏结果不会静默写出

空闲 REFLEX_SEMIF_IDLE_SEC 秒（默认 900）自退；socket/pid 在 $REFLEX_HOME/run/ 下。
"""
from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import sys
import time

HOME = os.path.expanduser("~")
REFLEX = os.environ.get("REFLEX_HOME") or os.path.join(HOME, ".dsh", "dsh-reflex")
RUN_DIR = os.environ.get("REFLEX_SEMIF_RUN_DIR") or os.path.join(REFLEX, "run")
SOCK_PATH = os.path.join(RUN_DIR, "semif.sock")
PID_PATH = os.path.join(RUN_DIR, "semif.pid")
LOG_PATH = os.path.join(REFLEX, "semif-resident.log")
IDLE_SEC = int(os.environ.get("REFLEX_SEMIF_IDLE_SEC", "900"))
MODEL = os.environ.get("REFLEX_SEMIF_MODEL", "mlx-community/Qwen3.5-4B-MLX-4bit")
REVISION = os.environ.get("REFLEX_SEMIF_REVISION", "32f3e8ecf65426fc3306969496342d504bfa13f3")
MAX_TOKENS = int(os.environ.get("REFLEX_SEMIF_MAX_TOKENS", "4096"))
REPO = os.environ.get("SEMIF_REPO", "")
VENV = os.environ.get("SEMIF_VENV", "")
VALIDATOR = os.environ.get(
    "REFLEX_SEMIF_VALIDATOR",
    os.path.join(HOME, ".agents", "skills", "semif-decide", "scripts", "validate_results.py"),
)

running = True


def log(msg: str) -> None:
    line = f"[{time.strftime('%Y-%m-%dT%H:%M:%S')}] {msg}"
    try:
        if os.path.exists(LOG_PATH) and os.path.getsize(LOG_PATH) > 5_000_000:
            os.replace(LOG_PATH, LOG_PATH + ".1")
        with open(LOG_PATH, "a") as f:
            f.write(line + "\n")
    except Exception:
        pass


def stop(_signum, _frame):
    global running
    running = False


def load_backend():
    src = os.path.join(REPO, "src") if REPO else ""
    if src and src not in sys.path:
        sys.path.insert(0, src)
    from semif_phase1 import mlx_backend  # noqa: E402
    from semif_phase1.core import validate_row  # noqa: E402

    t0 = time.time()
    model, tokenizer, metadata = mlx_backend.load_model(MODEL, REVISION)
    log(f"model loaded in {time.time() - t0:.2f}s ({MODEL}@{REVISION[:12]})")
    return mlx_backend, validate_row, model, tokenizer, metadata


def handle(backend, validate_row, model, tokenizer, metadata, request: dict) -> dict:
    mlx_backend = backend
    inp = request.get("input") or ""
    outp = request.get("output") or ""
    if not isinstance(inp, str) or not isinstance(outp, str) or not inp or not outp:
        return {"ok": False, "error": "input and output are required"}
    inp = os.path.abspath(inp)
    outp = os.path.abspath(outp)
    summary = outp + ".summary.md"
    if os.path.exists(outp) or os.path.exists(summary):
        return {"ok": False, "error": f"output already exists (SemIf is create-only): {outp}"}
    if not os.path.isfile(inp):
        return {"ok": False, "error": f"input not found: {inp}"}
    try:
        with open(inp) as f:
            rows = [json.loads(line) for line in f if line.strip()]
        if not rows:
            return {"ok": False, "error": "input is empty"}
        for row in rows:
            validate_row(row)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"invalid input: {e}"}

    os.makedirs(os.path.dirname(outp) or ".", exist_ok=True)
    tmp = f"{outp}.tmp.{os.getpid()}.{int(time.time() * 1000)}"
    tmp_summary = tmp + ".summary.md"
    t0 = time.time()
    try:
        with open(tmp, "x") as f:
            for row in rows:
                result = mlx_backend.score(model, tokenizer, row, metadata, MAX_TOKENS)
                f.write(json.dumps(result, allow_nan=False) + "\n")
                f.flush()
    except Exception as e:  # noqa: BLE001
        for p in (tmp, tmp_summary):
            if os.path.exists(p):
                os.unlink(p)
        return {"ok": False, "error": f"scoring failed: {e}"}
    score_seconds = time.time() - t0

    try:
        proc = subprocess.run(
            [
                os.path.join(VENV, "bin", "python") if VENV else sys.executable,
                VALIDATOR,
                "--input", inp,
                "--results", tmp,
                "--backend", "mlx",
                "--model", MODEL,
                "--revision", REVISION,
                "--summary-out", tmp_summary,
            ],
            capture_output=True, text=True, timeout=120,
        )
    except Exception as e:  # noqa: BLE001
        proc = None
        err = str(e)
    if proc is None or proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "")[-800:] if proc is not None else err
        for p in (tmp, tmp_summary):
            if os.path.exists(p):
                os.unlink(p)
        return {"ok": False, "error": f"validation failed: {detail.strip()}"}

    os.replace(tmp, outp)
    if os.path.exists(tmp_summary):
        os.replace(tmp_summary, summary)

    total = 0.0
    cases = 0
    try:
        with open(outp) as f:
            for line in f:
                if line.strip():
                    cases += 1
                    total += float(json.loads(line).get("total_seconds") or 0)
    except Exception:
        pass
    return {"ok": True, "cases": cases, "score_seconds": round(score_seconds, 3),
            "total_seconds": round(total, 4)}


def main() -> int:
    os.makedirs(RUN_DIR, exist_ok=True)
    for p in (SOCK_PATH, PID_PATH):
        try:
            os.unlink(p)
        except FileNotFoundError:
            pass
    try:
        backend, validate_row, model, tokenizer, metadata = load_backend()
    except Exception as e:  # noqa: BLE001
        log(f"startup failed: {e}")
        return 1

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGHUP, signal.SIG_IGN)

    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(SOCK_PATH)
    os.chmod(SOCK_PATH, 0o600)
    server.listen(8)
    server.settimeout(2.0)
    with open(PID_PATH, "w") as f:
        f.write(str(os.getpid()))
    log(f"listening on {SOCK_PATH} (pid {os.getpid()}, idle {IDLE_SEC}s)")

    last = time.time()
    try:
        while running:
            if time.time() - last > IDLE_SEC:
                log("idle timeout, exiting")
                break
            try:
                conn, _ = server.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            last = time.time()
            with conn:
                conn.settimeout(600)
                buf = b""
                try:
                    while b"\n" not in buf and len(buf) < 65_536:
                        chunk = conn.recv(4096)
                        if not chunk:
                            break
                        buf += chunk
                    req = json.loads(buf.decode() or "{}")
                except Exception as e:  # noqa: BLE001
                    resp = {"ok": False, "error": f"bad request: {e}"}
                else:
                    try:
                        resp = handle(backend, validate_row, model, tokenizer, metadata, req)
                    except Exception as e:  # noqa: BLE001
                        resp = {"ok": False, "error": f"handler crashed: {e}"}
                try:
                    conn.sendall((json.dumps(resp, ensure_ascii=False) + "\n").encode())
                except OSError:
                    pass
            last = time.time()
    finally:
        server.close()
        for p in (SOCK_PATH, PID_PATH):
            try:
                os.unlink(p)
            except FileNotFoundError:
                pass
        log("stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
