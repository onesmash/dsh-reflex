#!/usr/bin/env python3
"""decide-config.py 回归测试

两条都必须成立:
  1. 只改那三个字段, 其余字节(尤其 quietHours)原样保留
  2. 绝不发生 YAML sexagesimal 事故: safe_load('18:00') == 1080

第 2 条为什么是重点 —— 实测踩过:
    原先的实现用 yaml.safe_load 读整份 patch、safe_dump 写回。
    YAML 1.1 把「双位:两位」当 sexagesimal, 于是 '18:00' 被读成 1080,
    用户的安静时段被静默改成 from: 1080 -> 插件的 isQuietNow 判格式错误,
    安静时段直接失效。而 '09:00' 因前导零侥幸躲过, 所以问题只在某些值上显现。
    现在改成行级外科手术(只替换那三行), 本测试锁死这一点。
"""
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
TOOL = HERE.parent / 'tools' / 'decide-config.py'

FIXTURE = """- id: layered-agent
  name: ds-bot-layered-agent
  config:
    l0:
      sources:
      - disk
      - mail
    l1:
      targets:
      - disk
      quietHours:
        from: '18:00'
        to: 09:00
      profile: '用户: 某工程师'
    backend: ''
    jevBaseUrl: https://api.typesafe.ai
    jevModel: jev-latest
- id: another-plugin
  config:
    timeout: 30
"""

pass_n = 0
total = 0


def ok(label, cond, detail=""):
    global pass_n, total
    total += 1
    if cond:
        pass_n += 1
        print(f"  [{label}] ✅ 通过")
    else:
        print(f"  [{label}] ❌ 失败{' — ' + detail if detail else ''}")


def main():
    import yaml

    print("=== 0. 前提: 这个 YAML 陷阱确实存在(否则测试没意义) ===")
    ok("safe_load('18:00') == 1080", yaml.safe_load("18:00") == 1080)
    ok("safe_load('09:00') == '09:00'", yaml.safe_load("09:00") == "09:00")

    with tempfile.TemporaryDirectory() as td:
        home = pathlib.Path(td)
        prof = home / "profiles" / "desktop"
        prof.mkdir(parents=True)
        patch = prof / "cordis.patch.yml"
        patch.write_text(FIXTURE)
        before_text = patch.read_text()
        before = yaml.safe_load(before_text)
        env = dict(os.environ, DSH_HOME=str(home))

        print("\n=== 1. show 能读出当前值 ===")
        r = subprocess.run([sys.executable, str(TOOL), "show"], env=env,
                           capture_output=True, text=True)
        ok("show 退出码 0", r.returncode == 0, r.stderr.strip())
        ok("show 读到 backend=''", "backend      = ''" in r.stdout, r.stdout[-200:])
        ok("show 读到 quietHours 正常", "sexagesimal" not in r.stdout)

        print("\n=== 2. set 只改那三个字段 ===")
        r = subprocess.run([sys.executable, str(TOOL), "use", "openrouter"], env=env,
                           capture_output=True, text=True)
        ok("set 退出码 0", r.returncode == 0, r.stderr.strip())
        after_text = patch.read_text()
        after = yaml.safe_load(after_text)

        def entry(doc):
            return [e for e in doc if isinstance(e, dict) and e.get("id") == "layered-agent"][0]["config"]

        ca, cb = entry(before), entry(after)
        ok("backend 写入正确", cb["backend"] == "jev", repr(cb.get("backend")))
        ok("jevBaseUrl 写入正确", cb["jevBaseUrl"] == "https://openrouter.ai/api/v1")
        ok("jevModel 写入正确", cb["jevModel"] == "typesafe/jev-1.13")

        print("\n=== 3. 关键: quietHours 必须活下来(sexagesimal 事故) ===")
        ok("quietHours.from 仍是 '18:00'", cb["l1"]["quietHours"]["from"] == "18:00",
           f"实得 {cb['l1']['quietHours']['from']!r}")
        ok("quietHours.to 仍是 '09:00'", cb["l1"]["quietHours"]["to"] == "09:00")
        ok("文本里没有 'from: 1080'", "from: 1080" not in after_text)

        print("\n=== 4. 其余内容原样保留 ===")
        ok("l0 未变", ca["l0"] == cb["l0"])
        ok("l1 未变(含 profile)", ca["l1"] == cb["l1"])
        ids_a = [e.get("id") for e in before if isinstance(e, dict)]
        ids_b = [e.get("id") for e in after if isinstance(e, dict)]
        ok("其它插件条目无增删", ids_a == ids_b, f"{ids_a} -> {ids_b}")
        other_a = [e for e in before if isinstance(e, dict) and e.get("id") == "another-plugin"]
        other_b = [e for e in after if isinstance(e, dict) and e.get("id") == "another-plugin"]
        ok("another-plugin 原样", other_a == other_b)

        print("\n=== 5. 改动的行数应当很少(行级外科手术) ===")
        diff_lines = [l for l in after_text.splitlines() if l not in before_text.splitlines()]
        ok("新增/变化行 <= 3", len(diff_lines) <= 3, f"实际 {len(diff_lines)}: {diff_lines}")

        print("\n=== 6. 切回 semif 往返 ===")
        r = subprocess.run([sys.executable, str(TOOL), "use", "semif"], env=env,
                           capture_output=True, text=True)
        ok("切回退出码 0", r.returncode == 0, r.stderr.strip())
        back = yaml.safe_load(patch.read_text())
        ok("backend 回到空", entry(back)["backend"] == "")
        ok("quietHours 仍完好", entry(back)["l1"]["quietHours"]["from"] == "18:00")

        print("\n=== 7. 损坏的数据能被 show 检出 ===")
        bad = patch.read_text().replace("        from: '18:00'\n", "        from: 1080\n")
        patch.write_text(bad)
        r = subprocess.run([sys.executable, str(TOOL), "show"], env=env,
                           capture_output=True, text=True)
        ok("show 报告 sexagesimal 告警", "sexagesimal" in r.stdout, r.stdout[-200:])

    print(f"\n结果: {pass_n}/{total} 通过")
    return 0 if pass_n == total else 1


if __name__ == "__main__":
    sys.exit(main())
