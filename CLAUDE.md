# Cache

A Claude Code mod: a status line under the prompt in the Claude Desktop Code tab with the prompt-cache countdown and the session cost. Desktop only; the terminal and VS Code have better tools of their own.

## Working on it

- Load the `plugin-authoring` skill before touching `hooks/`: it holds the mod API's types and docs.
- Check every change with `claude plugin test .` and `claude plugin validate .`.
- Write a failing test in `tests/cache.test.ts` before each fix.
- Read time from `$.clock.now()`, so the tests' mock clock drives it.

## Gotchas

- `turn.start` and `turn.complete` fire for subagents too (`e.agentId`); the countdown follows the main loop alone.
- The plugin name `Cache` is also the `$.state` key in `hooks/register.tsx` and `types/index.d.ts`; a rename changes all three.
- In tests, register every hook before the first `$` call, one hook per event.

## Files

- `README.md` is for people installing the plugin.
- `design/icon.svg` is the source of `.claude-plugin/icon.png`. Regenerate with `qlmanage -t -s 1024 -o /tmp design/icon.svg`. Keep the SVG out of `.claude-plugin/` and `assets/`: the validator would take it as the icon and reject it.
