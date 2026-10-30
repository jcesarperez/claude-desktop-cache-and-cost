import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE

// Prompt-cache TTL of this plan (the `cacheTtl` option); the API refreshes it on every response.
let ttlMs = HOUR

const lastAt = atom({ plugin: 'Cache', key: 'lastAt' } as const, null, {
  shape: 'last-at-1',
})
const isRunning = atom({ plugin: 'Cache', key: 'isRunning' } as const, false, {
  shape: 'is-running-1',
})
// The model the cache was written for: each model keeps its own.
const cachedModel = atom({ plugin: 'Cache', key: 'cachedModel' } as const, null, {
  shape: 'cached-model-1',
})

type $ = EngineInterface
type Saved = { lastAt: number; model: string | null }

let tick: Timer | undefined

const schedule = ($: $, ms: number) => {
  tick?.cancel()
  tick = $.clock.after(ms, () => void refresh($))
}

// `$.state` lasts one process; the store keeps the countdown for a resumed session.
const save = async ($: $) => {
  const at = await read($, lastAt)
  if (at === null) return

  const key = `session:${await $.session.id()}`
  const now = await $.clock.now()
  await $.store.set(key, { lastAt: at, model: await read($, cachedModel) } satisfies Saved)

  // Drop other sessions' entries once no TTL could still cover them.
  for (const other of await $.store.keys()) {
    const saved = (await $.store.get(other)) as Saved | undefined
    if (other !== key && other.startsWith('session:') && (saved?.lastAt ?? 0) < now - HOUR) await $.store.delete(other)
  }
}

const restore = async ($: $) => {
  if ((await read($, lastAt)) !== null) return

  const saved = (await $.store.get(`session:${await $.session.id()}`)) as Saved | undefined
  if (saved === undefined) return

  await update($, lastAt, () => saved.lastAt)
  await update($, cachedModel, () => saved.model)
}

const refresh = async ($: $) => {
  // Once a minute by default: picks up a surface that attaches later, a model switch, and the cost.
  schedule($, MINUTE)

  // Built for the desktop Code tab; the terminal and VS Code have their own.
  if (!(await $.session.surfaces()).includes('desktop')) {
    $.ui.status(undefined)
    return
  }

  const at = await read($, lastAt)
  const running = await read($, isRunning)
  const model = await read($, cachedModel)
  const isOtherModel = model !== null && model !== (await $.session.model())
  const usd = (await $.session.usage()).cost?.usd
  const left = at === null ? null : isOtherModel ? 0 : ttlMs - ((await $.clock.now()) - at)
  const label = running
    ? 'Running'
    : left === null
      ? '—'
      : left <= 0
        ? 'Expired'
        : `${Math.floor(left / MINUTE)}m`

  // While counting down, redraw just after the minute shown changes.
  if (!running && left !== null && left > 0) schedule($, (left % MINUTE) + 100)

  $.ui.status(`${left !== null && left <= 0 && !running ? '⭕' : '⏲'} ${label}${usd === undefined ? '' : ` · $${usd.toFixed(2)}`}`)
}

export const register: Register = (on, options) => {
  ttlMs = options.cacheTtl === '5m' ? 5 * MINUTE : HOUR

  on('session.start', async ($, e, next) => {
    void restore($).then(() => refresh($))

    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    void refresh($)

    return next(e)
  })

  on('session.detach', async ($, e, next) => {
    void refresh($)

    return next(e)
  })

  // Subagents keep their own cache and their turns overlap the main one: follow the main loop alone.
  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)

    await update($, isRunning, () => true)
    await refresh($)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)

    await update($, isRunning, () => false)
    // No usage means no response came back (an early interrupt or API error), so the cache was not refreshed.
    if (e.usage !== undefined) {
      const now = await $.clock.now()
      const model = await $.session.model()
      await update($, lastAt, () => now)
      await update($, cachedModel, () => model)
      await save($)
    }
    await refresh($)

    return next(e)
  })

  // A compacted conversation is a new prefix: the next turn writes the cache afresh.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || e.trigger === 'precompute' || result.messages === undefined) return result

    await update($, lastAt, () => 0)
    await save($)
    await refresh($)

    return result
  })
}
