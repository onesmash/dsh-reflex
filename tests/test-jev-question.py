#!/usr/bin/env python3
"""jev_question 的 criteria 不能是 null —— 实测会被 OpenRouter 400 拒掉。

真实现场:
  送 {"type":"noul","criteria":{"true":null,"false":null}}
  -> HTTP 400, 报
     path: ["questions","q","criteria","true"]
     expected string | record | array,  received null
  原因是 SemIf 的选项常常没有 description, 旧实现直接写 None。
  这类失败是"静默"的: 适配器把单条失败记进 stderr 后继续, 整轮可能 0 输出。

本测试锁死: 无论选项有没有 description, criteria 的每个值都必须是非空字符串。
"""
import importlib.util
import os
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
# semif-adapt.py 是运行时工具, 不在仓库里 —— 它在统一运行目录。
# 旧版写 HERE.parent / 'tools'(仓库 tools/), 但 tools/ 已移出仓库不再跟踪,
# 那样定位必然 FileNotFoundError。现在从 LAYERED_HOME/tools/ 找;
# 找不到 = 本机不是装配环境, 跳过而不是假装失败。
_la_home = pathlib.Path(os.environ.get("LAYERED_HOME") or (
    pathlib.Path(os.environ.get("HOME", "~")).expanduser()
    / ".dsh" / "dsh-reflex"
))
TOOL = _la_home / "tools" / "semif-adapt.py"

if not TOOL.is_file():
    print(f"跳过: 未找到运行时工具 {TOOL}")
    print("(semif-adapt.py 在 LAYERED_HOME/tools/, 仓库不跟踪 tools/)")
    sys.exit(0)

spec = importlib.util.spec_from_file_location('semif_adapt', TOOL)
sa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sa)

pass_n = total = 0


def ok(label, cond, detail=''):
    global pass_n, total
    total += 1
    if cond:
        pass_n += 1
        print(f'  [{label}] ✅ 通过')
    else:
        print(f'  [{label}] ❌ 失败{" — " + detail if detail else ""}')


def row(opts, order_sensitive=False):
    r = {'id': 'x', 'state': {}, 'question': 'Q?', 'options': opts}
    return sa.jev_question(r, order_sensitive)


print('=== 1. noul(二元): 选项无 description 时不能给 null ===')
q, ids = row([{'id': 'yes', 'description': None}, {'id': 'no', 'description': None}])
ok('type=noul', q['type'] == 'noul', q.get('type'))
ok('criteria 无 None', all(v is not None for v in q['criteria'].values()), repr(q['criteria']))
ok('criteria 全是非空字符串',
   all(isinstance(v, str) and v.strip() for v in q['criteria'].values()), repr(q['criteria']))

print('\n=== 2. choice(多选项, 无序) ===')
q2, _ = row([{'id': 'a'}, {'id': 'b'}, {'id': 'insufficient'}])
ok('type=choice', q2['type'] == 'choice')
ok('criteria 无 None', all(v is not None for v in q2['criteria'].values()), repr(q2['criteria']))

print('\n=== 3. score(有序) ===')
q3, _ = row([{'id': 'low'}, {'id': 'mid', 'description': '中等'}, {'id': 'high'}], order_sensitive=True)
ok('type=score', q3['type'] == 'score')
ok('criteria 是列表', isinstance(q3['criteria'], list))
ok('列表内无 None', all(v is not None for v in q3['criteria']), repr(q3['criteria']))
ok('保留已有 description', '中等' in q3['criteria'], repr(q3['criteria']))

print('\n=== 4. 有 description 时必须原样使用(不能被回退文本顶掉) ===')
q4, _ = row([{'id': 'yes', 'description': '有明确异常'}, {'id': 'no', 'description': '一切正常'}])
ok('yes 用原描述', q4['criteria']['true'] == '有明确异常', repr(q4['criteria']))
ok('no 用原描述', q4['criteria']['false'] == '一切正常', repr(q4['criteria']))

print('\n=== 5. 空字符串 description 也要被当成"缺失"(strip 后为空) ===')
q5, _ = row([{'id': 'yes', 'description': '   '}, {'id': 'no', 'description': ''}])
ok('空白描述被回退', all(v.strip() for v in q5['criteria'].values()), repr(q5['criteria']))

print(f'\n结果: {pass_n}/{total} 通过')
sys.exit(0 if pass_n == total else 1)
