#!/usr/bin/env bash
# Print the current pinned commit (40-char) for a Hugging Face repo.
# Remote SemIf loads REQUIRE this as --revision; the loader rejects branch names like `main`.
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <org/repo>   e.g. $0 mlx-community/Qwen3.5-4B-MLX-4bit" >&2
  exit 2
fi

repo="$1"
sha="$(curl -fsSL "https://huggingface.co/api/models/$repo" | python3 -c 'import json,sys; print(json.load(sys.stdin)["sha"])')"
if ! [[ "$sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "error: could not resolve a 40-char commit for $repo (got: $sha)" >&2
  exit 1
fi
echo "$sha"
