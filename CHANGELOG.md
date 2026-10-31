# Changelog

## 0.3.0 - 2026-10-31

- The countdown runs from the start of the last request that read or wrote the cache, as the API counts it, not from the end of the turn. A long response or an interrupted tool no longer leaves it showing more time than the cache has.
- A request that neither read nor wrote the cache keeps the countdown it had.
- The countdown reads the cache's TTL (1 hour or 5 minutes) from the session's transcript after each turn, and follows it when it changes. The `cacheTtl` option is gone.
- A session the plugin kept no record of, from before it was installed or from days ago, takes its countdown from its transcript: it shows the time left when the cache is still warm, and `Expired` when it is not, instead of `—`.

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
