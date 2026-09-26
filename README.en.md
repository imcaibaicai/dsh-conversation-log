# dsh-conversation-log

简体中文 | [English](README.en.md)

Readable, per-session conversation logs for DeepSeek Harness (dsh). Every session is automatically written as a standalone readable file (Markdown + JSONL) whose name carries the date, time and topic; a searchable index is maintained alongside, so any past conversation can be recalled with a single natural-language sentence. Pure plugin — no core changes, no official files touched.

## The problem it solves

DSH stores each session as a multi-frame zstd-compressed JSONL (`~/.dsh/sessions/<workspace>/<session-id>/session.v3.jsonl.zstd`): unreadable from outside, UUID filenames, no titles. The time and topic are actually all in there (`session/title` events + record headers) — what was missing is a readable mirror. This plugin is that mirror:

- One file per session: `2026-09-26_14-32_poster-design-draft_ab12cd34.md` (plus a `.jsonl` machine-readable twin)
- Markdown header table: session id, created/last-active time, turns, message count, tool-call count, workspace
- Body laid out turn by turn: user messages, assistant prose, reasoning (collapsed in `<details>`), tool-call arguments and results

## Features

| Feature | How |
|---|---|
| Auto-record | Zero-effort. One full scan at startup, then a 5-second incremental loop: non-active sessions by file fingerprint, the active session by an in-memory content fingerprint — new events land in the record within ~5s of a turn ending |
| One-sentence recall | Just say “find the conversation about the poster design” or “yesterday's Verilog talk” in chat — the model calls the `conversation_recall` tool (fuzzy match on title + keywords + time expressions) and gets candidate sessions with record file paths |
| Settings-page search | Settings → Conversation Log: search box + result list (open session / preview record / show in folder / copy path) |
| Session header button | Download icon at the top right of a session — save the current conversation on demand |
| Slash commands | `/conversations [keywords]` to search or list; `/save-conversation [--id <id>]` to save now |

## Output location

Default fallback chain (configurable in Settings):

1. `~/Documents/dsh-conversations/`
2. `<DSH_HOME>/conversation-logs/`

Deployers can pin any directory via the plugin row's `config.outDir`.

## Install

```bash
dsh plugin --profile web add -w dsh-conversation-log
```

Restart DSH (host-side plugins need a full restart). The first launch scans all existing sessions automatically.

## Configuration

Plugin-row `config` defaults (all optional):

```yaml
- insert:
    - id: conversation-log
      name: 'dsh-conversation-log'
      config:
        outDir: ''              # empty = default fallback chain
        intervalSeconds: 5      # scan interval, 5–600
        enabled: true
        contentMode: full       # full = reasoning + tools | text = dialogue only
        formats: [md, jsonl]
```

Runtime settings (toggle / directory / interval / content mode / formats) live in Settings → Conversation Log and persist to `<DSH_HOME>/conversation-log-settings.json`.

## Implementation notes

- Reads through the official `ctx.sessionQuery` service (live-preferred, cold-readable, version-normalized); **never writes to session logs**
- Only human messages are recorded (`source.kind` of `user`/`steering`); AGENTS.md instructions and plugin runtime snapshots are filtered out
- Handles both v0 (`assistant/chunk` incremental) and v3 (`assistant/message` consolidated) log formats
- Every registration (model tool / slash commands / HTTP routes / scan timer) is individually try/catch-wrapped, so a plugin failure can never take down the plugin tree
- HTTP routes under `/ds-convo` (state / settings / search / save / file / reveal); POST routes are same-origin checked; file/reveal are strictly confined to the record directory
- Redaction: records are verbatim by default; pair with the built-in `@deepseek-ai/dsh-session-log-export` (`/export`) when you need sanitized copies

## Uninstall

Remove the `conversation-log` insert row from `cordis.patch.yml`, delete the package directory, restart. Record files stay in the output directory.

## Compatibility

- DeepSeek Harness `0.1.5-rc.1` (web profile)
- Client side requires only `react` / `react/jsx-runtime` (both in the platform baseline table)
- All slots are official reserved list slots: `settings.general.item`, `settings.section`, `conversation.session.header.utilities`

## License

MIT
