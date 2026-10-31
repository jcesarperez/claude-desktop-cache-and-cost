import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderSurface, SessionUsage } from 'claude-code'

const MINUTE = 60 * 1000
const START = 1_000_000_000

// Stands for the engine beneath the plugin; `status()` reads the line last pinned.
const engine = (
  on: On,
  {
    surfaces = ['desktop'],
    usd = 1.5,
    store = {},
    env = { HOME: '/home/me' },
  }: { surfaces?: RenderSurface[]; usd?: number | null; store?: Record<string, unknown>; env?: Record<string, string> } = {},
) => {
  const clock = mock.clock(on, { now: START })
  let line: string | undefined
  let model = 'opus'

  const saved: Record<string, unknown> = { ...store }
  on('store.get', (_, e) => ({ value: saved[e.key] }))
  on('store.set', (_, e) => {
    saved[e.key] = e.value
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    delete saved[e.key]
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(saved) }))
  on('session.id', () => ({ value: 's1' }))
  on('session.model', () => ({ value: model }))
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }] }))

  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.surfaces', () => ({ value: surfaces }))
  on('session.usage', () => ({
    value: { startedAt: START, rateLimits: [], ...(usd === null ? {} : { cost: { usd } }) } as unknown as SessionUsage,
  }))
  on('ui.status', (_, e) => {
    line = e.text
    return { value: undefined }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  // The API beneath: one chunk, then the response with the usage `step` set.
  on('turn.step', async function* (_, e) {
    yield { kind: 'text', index: 0, text: '' }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: response.usage === null ? null : 'end_turn', usage: response.usage }
  })

  // The host beneath `$.process.run`: `files` maps a path to its content, `tail` reads its end.
  const files: Record<string, string> = {}
  const runs: string[][] = []
  let isTailBroken = false
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const fail = { value: { exitCode: 1, stdout: '', stderr: 'no', isStdoutTruncated: false, isStderrTruncated: false } }
    const [command, ...args] = e.argv
    if (command === 'printenv') return env[args[0]] === undefined ? fail : ok(`${env[args[0]]}\n`)
    if (command === 'find') {
      const [root, , name] = args
      const found = Object.keys(files).filter((path) => path.startsWith(`${root}/`) && path.endsWith(`/${name}`))
      return ok(found.map((path) => `${path}\n`).join(''))
    }
    if (command === 'tail') {
      if (isTailBroken) throw new Error('tail is gone')
      const content = files[args[2]]
      return content === undefined ? fail : ok(content.slice(-Number(args[1])))
    }
    return fail
  })

  return {
    clock,
    status: () => line,
    saved,
    files,
    runs,
    breakTail: () => {
      isTailBroken = true
    },
    useModel: (next: string) => {
      model = next
    },
  }
}

const USAGE = { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' }

const TRANSCRIPT = '/home/me/.claude/projects/-work/s1.jsonl'

const iso = (at: number) => new Date(at).toISOString()

// A main-thread response row as the transcript files it; `ttl` names its cache write, none for a pure read.
const row = ({
  ttl,
  isSidechain = false,
  read = 1000,
  at,
  parent,
  id = 'msg',
  model = 'opus',
}: { ttl?: '1h' | '5m'; isSidechain?: boolean; read?: number; at?: number; parent?: string; id?: string; model?: string } = {}) =>
  JSON.stringify({
    type: 'assistant',
    isSidechain,
    uuid: `${id}-${at}`,
    ...(parent === undefined ? {} : { parentUuid: parent }),
    ...(at === undefined ? {} : { timestamp: iso(at) }),
    message: {
      id,
      model,
      usage: {
        cache_read_input_tokens: read,
        cache_creation_input_tokens: ttl === undefined ? 0 : 100,
        cache_creation: { ephemeral_1h_input_tokens: ttl === '1h' ? 100 : 0, ephemeral_5m_input_tokens: ttl === '5m' ? 100 : 0 },
      },
    },
  }) + '\n'

// The prompt row a request answers, and the row Claude Code files as it sends the request.
const prompt = (at: number, uuid: string) => JSON.stringify({ type: 'user', isSidechain: false, uuid, timestamp: iso(at) }) + '\n'
const request = (at: number) => JSON.stringify({ type: 'api-request', timestamp: iso(at) }) + '\n'

// What the next step's response reports; `step` sets it before each request.
const response: { usage: typeof USAGE | null } = { usage: USAGE }

// One model request of the turn; `whileStreaming` runs after the request is sent, before the response ends.
const step = async (
  $: Engine,
  { agentId, usage = USAGE, whileStreaming }: { agentId?: string; usage?: typeof USAGE | null; whileStreaming?: () => Promise<void> } = {},
) => {
  response.usage = usage
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'opus', messageCount: 1, ...(agentId === undefined ? {} : { agentId }) })
  await stream.next()
  await whileStreaming?.()
  for await (const _ of stream);
}

const turn = async (
  $: Engine,
  { agentId, usage = USAGE, whileStreaming }: { agentId?: string; usage?: typeof USAGE | null; whileStreaming?: () => Promise<void> } = {},
) => {
  await $.turn.start({ text: 'hi', turnId: 't1', ...(agentId === undefined ? {} : { agentId }) })
  await step($, { agentId, usage, whileStreaming })
  return () =>
    $.turn.complete({
      answer: '',
      durationMs: 1,
      isAborted: usage === null,
      turnId: 't1',
      reason: usage === null ? 'aborted' : 'answer',
      ...(agentId === undefined ? {} : { agentId }),
      ...(usage === null ? {} : { usage }),
    })
}

const start = async ($: Engine, clock: { settle: () => Promise<void> }) => {
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
}

for (const surface of ['terminal', 'vscode', 'mobile'] as const) {
  test(`shows nothing on ${surface}`, async ($, on) => {
    const { clock, status } = engine(on, { surfaces: [surface] })
    await start($, clock)
    await (await turn($))()

    expect(status()).toBe(undefined)
  })
}

test('shows a dash before the first turn', async ($, on) => {
  const { clock, status } = engine(on)
  await start($, clock)

  expect(status()).toBe('⏲ — · $1.50')
})

test('leaves the cost out when the host keeps none', async ($, on) => {
  const { clock, status } = engine(on, { usd: null })
  await start($, clock)

  expect(status()).toBe('⏲ —')
})

test('reads Running while a turn runs', async ($, on) => {
  const { clock, status } = engine(on)
  await start($, clock)
  await turn($)

  expect(status()).toBe('⏲ Running · $1.50')
})

test('counts down whole minutes from the last request', async ($, on) => {
  const { clock, status } = engine(on)
  await start($, clock)
  await (await turn($))()

  expect(status()).toBe('⏲ 60m · $1.50')
  await clock.advance(1000)
  expect(status()).toBe('⏲ 59m · $1.50')
  await clock.advance(30 * MINUTE)
  expect(status()).toBe('⏲ 29m · $1.50')
})

test('counts down from the start of the last request, not the end of its response', async ($, on) => {
  const { clock, status, files } = engine(on)
  files[TRANSCRIPT] = row({ ttl: '5m' })
  await start($, clock)
  await (await turn($, { whileStreaming: () => clock.advance(4 * MINUTE) }))()

  expect(status()).toBe('⏲ 1m · $1.50')
})

test('a request that neither read nor wrote the cache keeps the old countdown', async ($, on) => {
  const { clock, status } = engine(on)
  await start($, clock)
  await (await turn($))()
  await clock.advance(10 * MINUTE)
  await (await turn($, { usage: { ...USAGE, cache_read_input_tokens: 0 } }))()

  expect(status()).toBe('⏲ 50m · $1.50')
})

test('a subagent request leaves the countdown alone', async ($, on) => {
  const { clock, status } = engine(on)
  await start($, clock)
  await (await turn($))()
  await clock.advance(10 * MINUTE)
  await step($, { agentId: 'a1' })

  expect(status()).toBe('⏲ 50m · $1.50')
})

test('reads Expired once the TTL has passed', async ($, on) => {
  const { clock, status } = engine(on)
  await start($, clock)
  await (await turn($))()
  await clock.advance(61 * MINUTE)

  expect(status()).toBe('⭕ Expired · $1.50')
})

test('a subagent ending mid-turn keeps Running', async ($, on) => {
  const { clock, status } = engine(on)
  await start($, clock)
  await turn($)
  await (await turn($, { agentId: 'a1' }))()

  expect(status()).toBe('⏲ Running · $1.50')
})

test('a turn interrupted before any response keeps the old countdown', async ($, on) => {
  const { clock, status } = engine(on)
  await start($, clock)
  await (await turn($))()
  await clock.advance(10 * MINUTE)
  await (await turn($, { usage: null }))()

  expect(status()).toBe('⏲ 50m · $1.50')
})

test('assumes a 1-hour cache before the transcript shows one', async ($, on) => {
  const { clock, status } = engine(on)
  await start($, clock)
  await (await turn($))()

  expect(status()).toBe('⏲ 60m · $1.50')
})

test('counts down 5 minutes once the transcript shows a 5-minute cache write', async ($, on) => {
  const { clock, status, files } = engine(on)
  files[TRANSCRIPT] = row({ ttl: '5m' })
  await start($, clock)
  await (await turn($))()

  expect(status()).toBe('⏲ 5m · $1.50')
  await clock.advance(6 * MINUTE)
  expect(status()).toBe('⭕ Expired · $1.50')
})

test('follows the cache from 1 hour down to 5 minutes mid-session', async ($, on) => {
  const { clock, status, files } = engine(on)
  files[TRANSCRIPT] = row({ ttl: '1h' })
  await start($, clock)
  await (await turn($))()
  expect(status()).toBe('⏲ 60m · $1.50')

  files[TRANSCRIPT] += row({ ttl: '5m' })
  await (await turn($))()
  expect(status()).toBe('⏲ 5m · $1.50')
})

test('a response that only read the cache keeps the TTL of the last write', async ($, on) => {
  const { clock, status, files } = engine(on)
  files[TRANSCRIPT] = row({ ttl: '5m' }) + row()
  await start($, clock)
  await (await turn($))()

  expect(status()).toBe('⏲ 5m · $1.50')
})

test('a response not yet in the transcript keeps the TTL it had', async ($, on) => {
  const { clock, status, files } = engine(on)
  files[TRANSCRIPT] = row({ ttl: '5m' })
  await start($, clock)
  await (await turn($))()
  // The next turn's 1-hour write lands in the file only after the turn ends.
  await (await turn($))()

  expect(status()).toBe('⏲ 5m · $1.50')
})

test("a subagent's cache write leaves the TTL alone", async ($, on) => {
  const { clock, status, files } = engine(on)
  files[TRANSCRIPT] = row({ ttl: '5m' }) + row({ ttl: '1h', isSidechain: true })
  await start($, clock)
  await (await turn($))()

  expect(status()).toBe('⏲ 5m · $1.50')
})

test('skips the row the tail cuts in half and lines that are not JSON', async ($, on) => {
  const { clock, status, files } = engine(on)
  files[TRANSCRIPT] = 'x'.repeat(300_000) + row({ ttl: '1h' }) + '{"type":"assistant",\n' + 'not json\n' + row({ ttl: '5m' })
  await start($, clock)
  await (await turn($))()

  expect(status()).toBe('⏲ 5m · $1.50')
})

test('reads only the end of a long transcript', async ($, on) => {
  const { clock, files, runs } = engine(on)
  files[TRANSCRIPT] = row({ ttl: '5m' })
  await start($, clock)
  await (await turn($))()

  const tails = runs.filter(([command]) => command === 'tail')
  expect(tails.length > 0 && tails.every((argv) => argv.join(' ') === `tail -c 262144 ${TRANSCRIPT}`)).toBe(true)
})

test('finds the transcript under CLAUDE_CONFIG_DIR', async ($, on) => {
  const { clock, status, files } = engine(on, { env: { HOME: '/home/me', CLAUDE_CONFIG_DIR: '/profiles/work' } })
  files['/profiles/work/projects/-work/s1.jsonl'] = row({ ttl: '5m' })
  files[TRANSCRIPT] = row({ ttl: '1h' })
  await start($, clock)
  await (await turn($))()

  expect(status()).toBe('⏲ 5m · $1.50')
})

test('finds a transcript that shows up after the first turn', async ($, on) => {
  const { clock, status, files } = engine(on)
  await start($, clock)
  await (await turn($))()
  files[TRANSCRIPT] = row({ ttl: '5m' })
  await (await turn($))()

  expect(status()).toBe('⏲ 5m · $1.50')
})

test('looks the transcript up once', async ($, on) => {
  const { clock, files, runs } = engine(on)
  files[TRANSCRIPT] = row({ ttl: '5m' })
  await start($, clock)
  await (await turn($))()
  await (await turn($))()

  expect(runs.filter(([command]) => command === 'find').length).toBe(1)
})

test('keeps the TTL when the transcript can no longer be read', async ($, on) => {
  const { clock, status, files } = engine(on)
  files[TRANSCRIPT] = row({ ttl: '5m' })
  await start($, clock)
  await (await turn($))()
  delete files[TRANSCRIPT]
  await (await turn($))()

  expect(status()).toBe('⏲ 5m · $1.50')
})

test('keeps the TTL when reading the transcript fails outright', async ($, on) => {
  const { clock, status, files, breakTail } = engine(on)
  files[TRANSCRIPT] = row({ ttl: '5m' })
  await start($, clock)
  await (await turn($))()
  breakTail()
  await (await turn($))()

  expect(status()).toBe('⏲ 5m · $1.50')
})

test('a subagent ending reads no transcript', async ($, on) => {
  const { clock, files, runs } = engine(on)
  files[TRANSCRIPT] = row({ ttl: '5m' })
  await start($, clock)
  await turn($)
  runs.length = 0
  await (await turn($, { agentId: 'a1' }))()

  expect(runs).toEqual([])
})

test('switching model leaves the new one with no cache', async ($, on) => {
  const { clock, status, useModel } = engine(on)
  await start($, clock)
  await (await turn($))()
  useModel('sonnet')
  await clock.advance(MINUTE)

  expect(status()).toBe('⭕ Expired · $1.50')
})

test('switching back to the cached model shows its countdown again', async ($, on) => {
  const { clock, status, useModel } = engine(on)
  await start($, clock)
  await (await turn($))()
  useModel('sonnet')
  await clock.advance(MINUTE)
  useModel('opus')
  await clock.advance(MINUTE)

  expect(status()).toBe('⏲ 58m · $1.50')
})

test('compacting the conversation leaves no cache', async ($, on) => {
  const { clock, status } = engine(on)
  await start($, clock)
  await (await turn($))()
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] })
  await clock.settle()

  expect(status()).toBe('⭕ Expired · $1.50')
})

test('a resumed session picks up the countdown it left', async ($, on) => {
  const { clock, status } = engine(on, {
    store: { 'session:s1': { lastAt: START - 10 * MINUTE, model: 'opus' } },
  })
  await start($, clock)

  expect(status()).toBe('⏲ 50m · $1.50')
})

test('the countdown is kept for a later resume', async ($, on) => {
  const { clock, saved } = engine(on)
  await start($, clock)
  await (await turn($))()

  expect(saved['session:s1']).toEqual({ lastAt: START, model: 'opus', ttlMs: 60 * MINUTE })
})

test('a resumed session keeps the TTL it detected', async ($, on) => {
  const { clock, status } = engine(on, {
    store: { 'session:s1': { lastAt: START - MINUTE, model: 'opus', ttlMs: 5 * MINUTE } },
  })
  await start($, clock)

  expect(status()).toBe('⏲ 4m · $1.50')
})

// A session the plugin kept no record of: one from before it was installed, or one whose record it dropped.
test('a session with no record counts down from its transcript', async ($, on) => {
  const { clock, status, files } = engine(on)
  files[TRANSCRIPT] = prompt(START - 10 * MINUTE, 'p1') + request(START - 10 * MINUTE + 500) + row({ ttl: '1h', at: START - 6 * MINUTE, parent: 'p1' })
  await start($, clock)

  expect(status()).toBe('⏲ 50m · $1.50')
})

test('a session with no record reads Expired once its transcript is older than the TTL', async ($, on) => {
  const { clock, status, files } = engine(on)
  files[TRANSCRIPT] = prompt(START - 26 * 60 * MINUTE, 'p1') + request(START - 26 * 60 * MINUTE) + row({ ttl: '1h', at: START - 26 * 60 * MINUTE, parent: 'p1' })
  await start($, clock)

  expect(status()).toBe('⭕ Expired · $1.50')
})

test('a session with no record takes its TTL from the transcript', async ($, on) => {
  const { clock, status, files } = engine(on)
  files[TRANSCRIPT] = prompt(START - 2 * MINUTE, 'p1') + request(START - 2 * MINUTE) + row({ ttl: '5m', at: START - 2 * MINUTE, parent: 'p1' })
  await start($, clock)

  expect(status()).toBe('⏲ 3m · $1.50')
})

test('a session with no record counts from the last response that used the cache', async ($, on) => {
  const { clock, status, files } = engine(on)
  files[TRANSCRIPT] =
    prompt(START - 30 * MINUTE, 'p1') +
    request(START - 30 * MINUTE) +
    row({ ttl: '1h', at: START - 30 * MINUTE, parent: 'p1', id: 'm1' }) +
    prompt(START - 20 * MINUTE, 'p2') +
    request(START - 20 * MINUTE) +
    row({ read: 1000, at: START - 20 * MINUTE, parent: 'p2', id: 'm2' }) +
    prompt(START - 5 * MINUTE, 'p3') +
    request(START - 5 * MINUTE) +
    row({ read: 0, at: START - 5 * MINUTE, parent: 'p3', id: 'm3' })
  await start($, clock)

  expect(status()).toBe('⏲ 40m · $1.50')
})

test("a session with no record counts from its response's first row", async ($, on) => {
  const { clock, status, files } = engine(on)
  files[TRANSCRIPT] =
    prompt(START - 10 * MINUTE, 'p1') +
    request(START - 10 * MINUTE) +
    row({ ttl: '1h', at: START - 9 * MINUTE, parent: 'p1' }) +
    row({ ttl: '1h', at: START - 5 * MINUTE, parent: 'msg' })
  await start($, clock)

  expect(status()).toBe('⏲ 50m · $1.50')
})

test('a session with no record and no request row counts from the prompt', async ($, on) => {
  const { clock, status, files } = engine(on)
  files[TRANSCRIPT] = prompt(START - 10 * MINUTE, 'p1') + row({ ttl: '1h', at: START - 8 * MINUTE, parent: 'p1' })
  await start($, clock)

  expect(status()).toBe('⏲ 50m · $1.50')
})

test('a session with no record ignores a request row from before its prompt', async ($, on) => {
  const { clock, status, files } = engine(on)
  files[TRANSCRIPT] = request(START - 30 * MINUTE) + prompt(START - 10 * MINUTE, 'p1') + row({ ttl: '1h', at: START - 8 * MINUTE, parent: 'p1' })
  await start($, clock)

  expect(status()).toBe('⏲ 50m · $1.50')
})

test('a session with no record whose cache was for another model reads Expired', async ($, on) => {
  const { clock, status, files } = engine(on)
  files[TRANSCRIPT] = prompt(START - 10 * MINUTE, 'p1') + request(START - 10 * MINUTE) + row({ ttl: '1h', at: START - 10 * MINUTE, parent: 'p1', model: 'sonnet' })
  await start($, clock)

  expect(status()).toBe('⭕ Expired · $1.50')
})

test("a session with no record ignores a subagent's response", async ($, on) => {
  const { clock, status, files } = engine(on)
  files[TRANSCRIPT] =
    prompt(START - 30 * MINUTE, 'p1') +
    request(START - 30 * MINUTE) +
    row({ ttl: '1h', at: START - 30 * MINUTE, parent: 'p1' }) +
    row({ ttl: '1h', at: START - 5 * MINUTE, isSidechain: true, id: 'side' })
  await start($, clock)

  expect(status()).toBe('⏲ 30m · $1.50')
})

test('a session whose transcript never used the cache shows a dash', async ($, on) => {
  const { clock, status, files } = engine(on)
  files[TRANSCRIPT] = prompt(START - 10 * MINUTE, 'p1') + request(START - 10 * MINUTE) + row({ read: 0, at: START - 10 * MINUTE, parent: 'p1' })
  await start($, clock)

  expect(status()).toBe('⏲ — · $1.50')
})

test("a session's own record wins over its transcript", async ($, on) => {
  const { clock, status, files } = engine(on, {
    store: { 'session:s1': { lastAt: START - 20 * MINUTE, model: 'opus', ttlMs: 60 * MINUTE } },
  })
  files[TRANSCRIPT] = prompt(START - 10 * MINUTE, 'p1') + request(START - 10 * MINUTE) + row({ ttl: '1h', at: START - 10 * MINUTE, parent: 'p1' })
  await start($, clock)

  expect(status()).toBe('⏲ 40m · $1.50')
})
