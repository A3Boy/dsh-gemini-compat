# Eval corpus for Tool Schema Reinforcement

## Files

- `reinforcement-eval.jsonl` — 5 tasks covering single tool, multi-step shell, package JSON processing, 8+ step project analysis, and background job orchestration.

## Usage

Run each task twice with `toolSchemaReinforcement = off` (baseline A) and `toolSchemaReinforcement = required-only` (variant B), using the same model, endpoint, and project directory.

## Metrics

- First-pass tool call validity
- INVALID_ARGS rate
- Missing required field rate
- Post-INVALID_ARGS recovery rate
- Task completion (did the task produce a correct final answer?)
- Average tool calls per completed task