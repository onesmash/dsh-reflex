#!/usr/bin/env python3
"""semif 预检 (check_env.sh) 回归测试: state_root venv 候选补丁。

背景 (2026-10-23, dsh-reflex 0.3.2):
  setup_env.sh 在无现成带 semif-score 的 venv 时, 默认把 venv 建到
  $state_root/venv (= ${SEMIF_STATE_ROOT:-~/.cache/semif-decide}/venv)。
  但 check_env.sh 的 find_score_bin() 只查 $SEMIF_VENV_DIR / $REPO_DIR/.venv /
  ~/SourceCode/SemIf/.venv / PATH, 从不看 state_root —— 于是"只有 state_root venv"
  的干净机器上 preflight 误报 [MISSING] semif-score entry point。

  本测试验证补丁: check_env 现在认得 state_root/venv, 且读 SEMIF_STATE_ROOT。

用法: python3 tests/test-semif-preflight.py
不碰真实环境: 全程操作 /tmp 沙箱, 结束后还原 ~/SourceCode/SemIf/.venv。
"""
import os
import shutil
import subprocess
import sys
import tempfile

REPO = os.path.expanduser('~/SourceCode/dsh-reflex')
CHECK_ENV = os.path.join(REPO, 'skill/semif-decide/scripts/check_env.sh')
REAL_VENV = os.path.expanduser('~/SourceCode/SemIf/.venv')

results = []


def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(('PASS' if ok else 'FAIL') + f'  {name}' + (f'  [{detail}]' if detail and not ok else ''))


def sh(cmd, env=None, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, env=env, **kw)


def main():
    assert os.path.exists(CHECK_ENV), f'check_env.sh missing: {CHECK_ENV}'
    # 语法
    p = sh(['bash', '-n', CHECK_ENV])
    check('check_env.sh bash syntax', p.returncode == 0, p.stderr)

    # 沙箱: 造一个"只有 state_root/venv"的环境
    base = tempfile.mkdtemp(prefix='semif-preflight-')
    stateroot = os.path.join(base, 'state')
    venv = os.path.join(stateroot, 'venv', 'bin')
    os.makedirs(venv, exist_ok=True)
    # semif-score stub
    with open(os.path.join(venv, 'semif-score'), 'w') as f:
        f.write('#!/bin/bash\nexit 0\n')
    os.chmod(os.path.join(venv, 'semif-score'), 0o755)
    # python stub (非真 venv; 只验证入口检测, MLX import 项会 MISSING 属预期)
    for name in ('python', 'python3'):
        with open(os.path.join(venv, name), 'w') as f:
            f.write('#!/bin/bash\necho 3.14.7\n')
        os.chmod(os.path.join(venv, name), 0o755)

    real_venv_moved = False
    try:
        # 藏起真实 venv, 模拟"干净机器"
        if os.path.isdir(REAL_VENV):
            real_venv_bak = REAL_VENV + '.preflight-test-bak'
            shutil.move(REAL_VENV, real_venv_bak)
            real_venv_moved = True

        env = dict(os.environ, SEMIF_STATE_ROOT=stateroot)
        p = sh(['bash', CHECK_ENV], env=env)
        out = p.stdout
        check('state_root venv: semif-score 被识别 (不再 MISSING entry point)',
              '[OK]      semif-score:' in out and '[MISSING] semif-score entry point' not in out,
              out)
        check('state_root venv: 识别的是 state_root 路径', stateroot in out, out)
    finally:
        if real_venv_moved:
            shutil.move(real_venv_bak, REAL_VENV)
        shutil.rmtree(base, ignore_errors=True)

    # 还原后正常路径仍 5 ok / 0 missing (若本机真实 venv 存在)
    if os.path.isdir(REAL_VENV):
        p = sh(['bash', CHECK_ENV])
        check('还原后正常路径预检返回 0 missing', '0 missing' in p.stdout, p.stdout)

    fails = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(fails)}/{len(results)} passed")
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
