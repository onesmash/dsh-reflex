#!/usr/bin/env python3
"""Validate SemIf JSONL output and optionally write a compact Markdown summary."""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path


def read_jsonl(path: Path, label: str) -> list[dict]:
    if not path.is_file():
        raise ValueError(f"{label} does not exist: {path}")
    rows: list[dict] = []
    for line_number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not raw.strip():
            continue
        try:
            value = json.loads(raw)
        except json.JSONDecodeError as error:
            raise ValueError(f"{label} line {line_number} is not valid JSON: {error.msg}") from error
        if not isinstance(value, dict):
            raise ValueError(f"{label} line {line_number} must be a JSON object")
        rows.append(value)
    return rows


def markdown_cell(value: object) -> str:
    """Keep user-controlled ids and paths inert inside the Markdown summary."""
    return str(value).replace("\\", "\\\\").replace("`", "'").replace("|", "\\|").replace("\n", " ")


def validate(
    input_path: Path,
    result_path: Path,
    backend: str | None,
    model: str | None,
    revision: str | None,
) -> tuple[list[dict], dict]:
    inputs = read_jsonl(input_path, "input")
    results = read_jsonl(result_path, "result")
    if not inputs:
        raise ValueError("input has no decision rows")
    if len(results) != len(inputs):
        raise ValueError(f"row count mismatch: input={len(inputs)}, result={len(results)}")
    if revision is not None and (model is None or not Path(model).is_dir()) and not re.fullmatch(
        r"[0-9a-f]{40}", revision
    ):
        raise ValueError("remote model revision must be a 40-character lowercase hex commit")

    summary_rows: list[dict] = []
    for index, (source_row, result_row) in enumerate(zip(inputs, results), 1):
        expected_id = source_row.get("id")
        raw_options = source_row.get("options")
        if not isinstance(expected_id, str) or not expected_id:
            raise ValueError(f"input row {index} has an invalid id")
        if not isinstance(raw_options, list) or len(raw_options) < 2:
            raise ValueError(f"input row {index} must contain at least two options")
        expected_options = []
        for option in raw_options:
            if not isinstance(option, dict) or not isinstance(option.get("id"), str) or not option["id"]:
                raise ValueError(f"input row {index} has an invalid option id")
            expected_options.append(option["id"])
        if len(expected_options) != len(set(expected_options)):
            raise ValueError(f"input row {index} has duplicate option ids")
        if result_row.get("id") != expected_id:
            raise ValueError(
                f"row {index} id mismatch: expected {expected_id!r}, got {result_row.get('id')!r}"
            )
        if result_row.get("option_ids") != expected_options:
            raise ValueError(f"row {index} option_ids do not match the input options")

        probabilities = result_row.get("probabilities")
        if not isinstance(probabilities, list) or len(probabilities) != len(expected_options):
            raise ValueError(f"row {index} probabilities length does not match option_ids")
        if any(
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(value)
            for value in probabilities
        ):
            raise ValueError(f"row {index} probabilities contain a non-finite value")
        total = math.fsum(probabilities)
        if not math.isclose(total, 1.0, rel_tol=0.0, abs_tol=1e-5):
            raise ValueError(f"row {index} probabilities sum to {total:.9f}, not 1")
        if any(value < 0.0 or value > 1.0 for value in probabilities):
            raise ValueError(f"row {index} probabilities must be in [0, 1]")

        metadata = result_row.get("model")
        if not isinstance(metadata, dict):
            raise ValueError(f"row {index} is missing model provenance")
        expected_metadata = {"backend": backend, "source": model, "revision": revision}
        for key, expected in expected_metadata.items():
            if expected is not None and metadata.get(key) != expected:
                raise ValueError(
                    f"row {index} model.{key} mismatch: expected {expected!r}, got {metadata.get(key)!r}"
                )
        winner_index = max(range(len(probabilities)), key=probabilities.__getitem__)
        summary_rows.append(
            {
                "id": expected_id,
                "winner": expected_options[winner_index],
                "probability": probabilities[winner_index],
            }
        )
    return summary_rows, results[0].get("model", {})


def markdown_summary(
    input_path: Path,
    result_path: Path,
    rows: list[dict],
    metadata: dict,
) -> str:
    lines = [
        "# SemIf result validation",
        "",
        f"- Input: `{markdown_cell(input_path)}`",
        f"- Result: `{markdown_cell(result_path)}`",
        f"- Rows: `{len(rows)}`",
        f"- Backend: `{markdown_cell(metadata.get('backend', 'unknown'))}`",
        f"- Model: `{markdown_cell(metadata.get('source', 'unknown'))}`",
        f"- Revision: `{markdown_cell(metadata.get('revision', 'unknown'))}`",
        "",
        "Probabilities are conditional on the supplied option set; they are not calibrated real-world confidence.",
        "",
        "| Row | Winning option | Probability |",
        "|---|---|---:|",
    ]
    for row in rows:
        lines.append(
            f"| `{markdown_cell(row['id'])}` | `{markdown_cell(row['winner'])}` | "
            f"{row['probability']:.6f} |"
        )
    lines.extend(("", "Validation: passed."))
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--results", type=Path, required=True)
    parser.add_argument("--backend")
    parser.add_argument("--model")
    parser.add_argument("--revision")
    parser.add_argument("--summary-out", type=Path)
    args = parser.parse_args()
    try:
        rows, metadata = validate(args.input, args.results, args.backend, args.model, args.revision)
        summary = markdown_summary(args.input, args.results, rows, metadata)
        if args.summary_out:
            args.summary_out.parent.mkdir(parents=True, exist_ok=True)
            if args.summary_out.exists() or args.summary_out.is_symlink():
                raise ValueError(f"summary output already exists: {args.summary_out}")
            args.summary_out.write_text(summary, encoding="utf-8")
        sys.stdout.write(summary)
        return 0
    except (OSError, ValueError) as error:
        print(f"validation failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
