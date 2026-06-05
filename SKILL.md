---
name: codex-usage
description: Audit local Codex session token usage and estimate cost by model using models.dev pricing. Use when the user asks for Codex token totals, spend, usage by model, pricing, or cost reports from ~/.codex/sessions.
metadata:
  short-description: Price local Codex session usage
---

# Codex Usage

Use the bundled script for deterministic accounting:

```bash
node scripts/codex_usage.js
```

The script scans local Codex JSONL session logs, sums `token_count.info.last_token_usage` by the active model from each session's `turn_context`, rolls usage up by model and by month, and prices the totals from `https://models.dev/api.json`.

Useful flags:

- `--json`: emit machine-readable output. Without this flag, output is Markdown with by-model and by-month tables.
- `--sessions-root DIR`: scan a non-default Codex sessions directory. Defaults to `$CODEX_HOME/sessions` or `~/.codex/sessions`.
- `--cache-dir DIR`: override the cache directory. Defaults to this skill's `.cache/`.
- `--refresh-pricing`: refresh the cached models.dev catalog.
- `--no-session-cache`: rescan all session JSONL files.
- `--pricing-file FILE`: use a local models.dev-shaped catalog for tests or offline work.
- `--top-sessions N`: include the most expensive sessions per model in JSON output.

Caching:

- Session files are cached by absolute path, file size, and file modification timestamp.
- Pricing is cached separately with a 24-hour TTL unless `--refresh-pricing` is supplied.

When reporting results, mention whether pricing was fetched or cached and call out any unpriced models.
