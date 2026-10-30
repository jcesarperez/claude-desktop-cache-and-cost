# Changelog

## 0.2.0 - 2026-10-30

- Shows in the Claude Desktop Code tab only.
- New icons: `⏲` while the cache is warm, `⭕` once it has expired.
- The countdown shows whole minutes left and changes right on the minute.
- Subagents no longer reset the countdown or hide `Running`.
- A turn interrupted before any response keeps the countdown it had.
- Switching model or compacting the conversation shows `Expired`: the cache no longer covers it.
- A resumed session picks up its countdown.
- New `cacheTtl` option for a 5-minute cache.

## 0.1.0 - 2026-10-30

- First release: prompt-cache countdown and session cost in the status line.
