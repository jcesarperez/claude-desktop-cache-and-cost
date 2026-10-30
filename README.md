# Cache

Shows the prompt-cache countdown and the session cost as a single status line under the prompt in the Claude Desktop Code tab, for example `⏱ 56m · $1.11`.

The countdown starts when a turn ends and assumes a 1-hour cache TTL (edit `TTL_MS` in `hooks/register.tsx` if yours differs). While a turn runs it reads `Running`; once the cache lapses it reads `🔴 Expired`. The line refreshes every 15 seconds. No setup is needed.

## Install

In a terminal session:

```
/plugin install Cache --marketplace jcesarperez/claude-cache-status
```

From a shell:

```
claude plugin install Cache --marketplace jcesarperez/claude-cache-status
```

In the Claude desktop app: click + next to the prompt box, then Plugins, Add marketplace with `jcesarperez/claude-cache-status`, then Add plugin.

## License

MIT
