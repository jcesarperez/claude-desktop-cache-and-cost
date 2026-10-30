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
  }: { surfaces?: RenderSurface[]; usd?: number | null; store?: Record<string, unknown> } = {},
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

  return {
    clock,
    status: () => line,
    saved,
    useModel: (next: string) => {
      model = next
    },
  }
}

const USAGE = { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' }

const turn = async ($: Engine, { agentId, usage = USAGE }: { agentId?: string; usage?: typeof USAGE | null } = {}) => {
  await $.turn.start({ text: 'hi', turnId: 't1', ...(agentId === undefined ? {} : { agentId }) })
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

  expect(status()).toBe('⏱ — · $1.50')
})

test('leaves the cost out when the host keeps none', async ($, on) => {
  const { clock, status } = engine(on, { usd: null })
  await start($, clock)

  expect(status()).toBe('⏱ —')
})

test('reads Running while a turn runs', async ($, on) => {
  const { clock, status } = engine(on)
  await start($, clock)
  await turn($)

  expect(status()).toBe('⏱ Running · $1.50')
})

test('counts down whole minutes from the end of the turn', async ($, on) => {
  const { clock, status } = engine(on)
  await start($, clock)
  await (await turn($))()

  expect(status()).toBe('⏱ 60m · $1.50')
  await clock.advance(1000)
  expect(status()).toBe('⏱ 59m · $1.50')
  await clock.advance(30 * MINUTE)
  expect(status()).toBe('⏱ 29m · $1.50')
})

test('reads Expired once the TTL has passed', async ($, on) => {
  const { clock, status } = engine(on)
  await start($, clock)
  await (await turn($))()
  await clock.advance(61 * MINUTE)

  expect(status()).toBe('🔴 Expired · $1.50')
})

test('a subagent ending mid-turn keeps Running', async ($, on) => {
  const { clock, status } = engine(on)
  await start($, clock)
  await turn($)
  await (await turn($, { agentId: 'a1' }))()

  expect(status()).toBe('⏱ Running · $1.50')
})

test('a turn interrupted before any response keeps the old countdown', async ($, on) => {
  const { clock, status } = engine(on)
  await start($, clock)
  await (await turn($))()
  await clock.advance(10 * MINUTE)
  await (await turn($, { usage: null }))()

  expect(status()).toBe('⏱ 50m · $1.50')
})

test('counts down from the TTL the plugin is set to', { options: { cacheTtl: '5m' } }, async ($, on) => {
  const { clock, status } = engine(on)
  await start($, clock)
  await (await turn($))()

  expect(status()).toBe('⏱ 5m · $1.50')
  await clock.advance(6 * MINUTE)
  expect(status()).toBe('🔴 Expired · $1.50')
})

test('switching model leaves the new one with no cache', async ($, on) => {
  const { clock, status, useModel } = engine(on)
  await start($, clock)
  await (await turn($))()
  useModel('sonnet')
  await clock.advance(MINUTE)

  expect(status()).toBe('🔴 Expired · $1.50')
})

test('switching back to the cached model shows its countdown again', async ($, on) => {
  const { clock, status, useModel } = engine(on)
  await start($, clock)
  await (await turn($))()
  useModel('sonnet')
  await clock.advance(MINUTE)
  useModel('opus')
  await clock.advance(MINUTE)

  expect(status()).toBe('⏱ 58m · $1.50')
})

test('compacting the conversation leaves no cache', async ($, on) => {
  const { clock, status } = engine(on)
  await start($, clock)
  await (await turn($))()
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] })
  await clock.settle()

  expect(status()).toBe('🔴 Expired · $1.50')
})

test('a resumed session picks up the countdown it left', async ($, on) => {
  const { clock, status } = engine(on, {
    store: { 'session:s1': { lastAt: START - 10 * MINUTE, model: 'opus' } },
  })
  await start($, clock)

  expect(status()).toBe('⏱ 50m · $1.50')
})

test('the countdown is kept for a later resume', async ($, on) => {
  const { clock, saved } = engine(on)
  await start($, clock)
  await (await turn($))()

  expect(saved['session:s1']).toEqual({ lastAt: START, model: 'opus' })
})
