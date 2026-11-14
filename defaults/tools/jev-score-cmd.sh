#!/bin/bash
# 把 jev-score.mjs 包成插件工具们要的 --score-cmd 形式（--input/--output）
exec node "$HOME/SourceCode/dsh-reflex/jev-score.mjs" "$@"
