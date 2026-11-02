#!/usr/bin/env python3
"""向常驻 SemIf 打分器发一次请求（薄客户端）。

退出码：
  0  已由常驻服务完成（输出文件已落盘、已过校验器）
  3  服务不可用（没 socket / 连不上 / 响应坏）—— 调用方应回退到 run_score.sh 直调
  1  服务返回了明确的错误（例如 output 已存在、校验失败）
"""
from __future__ import annotations

import json
import os
import socket
import sys

HOME = os.path.expanduser("~")
REFLEX = os.environ.get("REFLEX_HOME") or os.path.join(HOME, ".dsh", "dsh-reflex")
RUN_DIR = os.environ.get("REFLEX_SEMIF_RUN_DIR") or os.path.join(REFLEX, "run")
SOCK_PATH = os.path.join(RUN_DIR, "semif.sock")


def main() -> int:
    args = sys.argv[1:]
    inp = outp = None
    for i, a in enumerate(args):
        if a == "--input" and i + 1 < len(args):
            inp = args[i + 1]
        elif a == "--output" and i + 1 < len(args):
            outp = args[i + 1]
    if not inp or not outp or not os.path.exists(SOCK_PATH):
        return 3

    payload = json.dumps({"input": os.path.abspath(inp), "output": os.path.abspath(outp)}) + "\n"
    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(5)
        sock.connect(SOCK_PATH)
        sock.settimeout(600)
        sock.sendall(payload.encode())
        buf = b""
        while b"\n" not in buf:
            chunk = sock.recv(4096)
            if not chunk:
                break
            buf += chunk
        sock.close()
    except (FileNotFoundError, ConnectionRefusedError, socket.timeout, OSError):
        return 3

    try:
        resp = json.loads(buf.decode() or "{}")
    except Exception:  # noqa: BLE001
        return 3

    if resp.get("ok"):
        # 成功时不写 stdout/stderr：shadow wrapper 的契约是「与 run_score.sh 输出风格一致」，
        # 不额外污染调用方的 stderr（进度/诊断在服务端日志里）。
        return 0
    sys.stderr.write("[semif-resident] error: %s\n" % (resp.get("error"),))
    return 1


if __name__ == "__main__":
    sys.exit(main())
