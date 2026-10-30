import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

// Prompt-cache TTL of this plan; the API refreshes it on every response.
const TTL_MS = 60 * 60 * 1000

const lastAt = atom({ plugin: 'Cache', key: 'lastAt' } as const, null, {
  shape: 'last-at-1',
})
const isRunning = atom({ plugin: 'Cache', key: 'isRunning' } as const, false, {
  shape: 'is-running-1',
})

const refresh = async ($: Parameters<typeof read>[0]) => {
  const at = await read($, lastAt)
  const running = await read($, isRunning)
  const usd = (await $.session.usage()).cost?.usd
  const left = at === null ? null : TTL_MS - (Date.now() - at)
  const label = running
    ? 'Running'
    : left === null
      ? '—'
      : left <= 0
        ? 'Expired'
        : `${Math.ceil(left / 60000)}m`

  $.ui.status(`${left !== null && left <= 0 && !running ? '🔴' : '⏱'} ${label}${usd === undefined ? '' : ` · $${usd.toFixed(2)}`}`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    void refresh($)
    $.clock.every(60000, () => void refresh($))

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await update($, isRunning, () => true)
    await refresh($)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await update($, isRunning, () => false)
    await update($, lastAt, () => Date.now())
    await refresh($)

    return next(e)
  })
}
