import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE

const lastAt = atom({ plugin: 'Cache', key: 'lastAt' } as const, null, {
  shape: 'last-at-1',
})
// The TTL of the main thread's last cache write, as the transcript shows it; 1 hour until it does.
const ttlMs = atom({ plugin: 'Cache', key: 'ttlMs' } as const, HOUR, {
  shape: 'ttl-ms-1',
})
const isRunning = atom({ plugin: 'Cache', key: 'isRunning' } as const, false, {
  shape: 'is-running-1',
})
// The model the cache was written for: each model keeps its own.
const cachedModel = atom({ plugin: 'Cache', key: 'cachedModel' } as const, null, {
  shape: 'cached-model-1',
})

type $ = EngineInterface
type Saved = { lastAt: number; model: string | null; ttlMs?: number }

let tick: Timer | undefined
let transcript: string | undefined

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
  await $.store.set(key, { lastAt: at, model: await read($, cachedModel), ttlMs: await read($, ttlMs) } satisfies Saved)

  // Drop other sessions' entries once no TTL could still cover them.
  for (const other of await $.store.keys()) {
    const saved = (await $.store.get(other)) as Saved | undefined
    if (other !== key && other.startsWith('session:') && (saved?.lastAt ?? 0) < now - HOUR) await $.store.delete(other)
  }
}

const restore = async ($: $) => {
  if ((await read($, lastAt)) !== null) return

  const saved = (await $.store.get(`session:${await $.session.id()}`)) as Saved | undefined
  if (saved === undefined) {
    // No record: a session from before the plugin, or one whose record was dropped once it expired.
    const found = await readTranscript($)
    if (found.lastAt === undefined) return
    await update($, lastAt, () => found.lastAt ?? null)
    await update($, cachedModel, () => found.model ?? null)
    await update($, ttlMs, () => found.ttlMs ?? HOUR)
    return
  }

  await update($, lastAt, () => saved.lastAt)
  await update($, cachedModel, () => saved.model)
  await update($, ttlMs, () => saved.ttlMs ?? HOUR)
}

// A command's output, or undefined when it failed or could not run.
const run = async ($: $, argv: string[]) => {
  try {
    const result = await $.process.run(argv)
    return result.exitCode === 0 ? result.stdout : undefined
  } catch {
    return undefined
  }
}

// The session id names the transcript under the config dir's projects; the classic hooks that carry its path may never reach a mod.
const findTranscript = async ($: $) => {
  if (transcript !== undefined) return transcript

  const configDir = (await run($, ['printenv', 'CLAUDE_CONFIG_DIR']))?.trim() || `${(await run($, ['printenv', 'HOME']))?.trim()}/.claude`
  const found = await run($, ['find', `${configDir}/projects`, '-name', `${await $.session.id()}.jsonl`])
  transcript = found?.split('\n')[0] || undefined
  return transcript
}

type Row = {
  type?: string
  isSidechain?: boolean
  uuid?: string
  parentUuid?: string
  timestamp?: string
  message?: {
    id?: string
    model?: string
    usage?: {
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
      cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number }
    }
  }
}

// What the transcript says of the main thread's cache, which the API reports there and never to a mod:
// the TTL of its last write, and when the last request that used it started, for which model.
const readTranscript = async ($: $): Promise<{ ttlMs?: number; lastAt?: number; model?: string }> => {
  const path = await findTranscript($)
  if (path === undefined) return {}

  // The end is enough, and a whole transcript can pass what one read takes.
  const tail = await run($, ['tail', '-c', '262144', path])
  const rows: Row[] = []
  for (const line of tail?.split('\n') ?? []) {
    try {
      const row = JSON.parse(line)
      if (typeof row === 'object' && row !== null) rows.push(row)
    } catch {}
  }

  const isMain = (row: Row) => row.type === 'assistant' && row.isSidechain === false
  let ttl: number | undefined
  let used = -1
  rows.forEach((row, i) => {
    if (!isMain(row)) return
    const usage = row.message?.usage
    if ((usage?.cache_creation?.ephemeral_1h_input_tokens ?? 0) > 0) ttl = HOUR
    else if ((usage?.cache_creation?.ephemeral_5m_input_tokens ?? 0) > 0) ttl = 5 * MINUTE
    if ((usage?.cache_read_input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0) > 0) used = i
  })
  if (used === -1) return { ttlMs: ttl }

  // A response files a row per block; the request started before its first, between it and the row it answers.
  const id = rows[used].message?.id
  const first = id === undefined ? used : rows.findIndex((row) => isMain(row) && row.message?.id === id)
  const parentUuid = rows[first].parentUuid
  const parent = parentUuid === undefined ? -1 : rows.findLastIndex((row, i) => i < first && row.uuid === parentUuid)
  const request = rows.findLastIndex((row, i) => i > parent && i < first && row.type === 'api-request')
  const startedAt = Date.parse((rows[request] ?? rows[parent] ?? rows[first]).timestamp ?? '')

  return { ttlMs: ttl, lastAt: Number.isNaN(startedAt) ? undefined : startedAt, model: rows[used].message?.model }
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
  const left = at === null ? null : isOtherModel ? 0 : (await read($, ttlMs)) - ((await $.clock.now()) - at)
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

export const register: Register = (on) => {
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

  // The API measures the cache's lifetime from the start of the request that read or wrote it, not from the end of its response.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)

    const sentAt = await $.clock.now()
    const result = yield* next(e)
    const usage = result.usage
    if (usage !== null && usage.cache_read_input_tokens + usage.cache_creation_input_tokens > 0) {
      const model = await $.session.model()
      await update($, lastAt, () => sentAt)
      await update($, cachedModel, () => model)
    }

    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)

    await update($, isRunning, () => false)
    // The turn's last response is usually in the transcript by now; one written later keeps the TTL found here.
    const ttl = (await readTranscript($)).ttlMs
    if (ttl !== undefined) await update($, ttlMs, () => ttl)
    await save($)
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
