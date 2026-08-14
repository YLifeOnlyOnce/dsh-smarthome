import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { apply } from '../src/index'
import type { Config } from '../src/config'
import { startMockHa } from './mock-ha'

const signal = new AbortController().signal
const fibers: Fiber[] = []

/**
 * Boot the REAL tool runtime (published @deepseek-ai packages) and mount our
 * plugin on it the same way the harness does — through the plugin registry,
 * so plugin-fiber effects (tool registration, WebSocket lifecycle) are real
 * and `fiber.dispose()` tears them down.
 */
async function setup(overrides: Partial<Config> = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const fiber = await ctx.plugin({ inject: ['tools'], apply }, {
    baseUrl: `http://127.0.0.1:${port}`,
    token: 'test-token',
    tokenEnv: '',
    timeoutMs: 2000,
    requireApproval: true,
    allowedDomains: [],
    maxHistoryEvents: 100,
    wsEnabled: true,
    eventBufferSize: 50,
    ...overrides,
  } satisfies Config)
  fibers.push(fiber)
  return ctx
}

function textOf(result: ToolExecutionResult): string {
  return result.content.map(b => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n')
}

let server: Server
let port: number

beforeAll(async () => {
  const mock = await startMockHa()
  server = mock.server
  port = mock.port
})

afterEach(async () => {
  for (const fiber of fibers.splice(0)) await fiber.dispose()
})

afterAll(() => {
  server.close()
})

describe('dsh-smarthome in the real tool runtime', () => {
  it('registers all eight ha_* tools', async () => {
    const ctx = await setup()
    const names = ctx.tools.schemas().map(s => s.name).sort()
    expect(names).toEqual([
      'ha_call_service',
      'ha_events',
      'ha_get_state',
      'ha_health',
      'ha_history',
      'ha_list_areas',
      'ha_list_entities',
      'ha_render_template',
    ])
  })

  it('ha_health reaches the mock and reports websocket status', async () => {
    const ctx = await setup()
    const result = await ctx.tools.execute({
      signal,
      callId: CallId('t-health'),
      name: 'ha_health',
      arguments: {},
    })
    expect(result.isError).toBe(false)
    expect((result.value as { reachable?: boolean }).reachable).toBe(true)
    expect((result.value as { websocket?: string }).websocket).toMatch(/disconnected|connecting|unavailable/)
    expect(textOf(result)).toContain('Home Assistant reachable')
  })

  it('ha_list_entities filters by domain', async () => {
    const ctx = await setup()
    const result = await ctx.tools.execute({
      signal,
      callId: CallId('t-list'),
      name: 'ha_list_entities',
      arguments: { domain: 'light' },
    })
    expect(result.isError).toBe(false)
    const entities = (result.value as { entities: { entity_id: string }[] }).entities
    expect(entities.map(e => e.entity_id)).toEqual(['light.living_room'])
  })

  it('ha_get_state returns the full state object', async () => {
    const ctx = await setup()
    const result = await ctx.tools.execute({
      signal,
      callId: CallId('t-state'),
      name: 'ha_get_state',
      arguments: { entityId: 'light.living_room' },
    })
    expect(result.isError).toBe(false)
    expect((result.value as { entity_id: string }).entity_id).toBe('light.living_room')
    expect(textOf(result)).toContain('brightness')
  })

  it('the approval gate blocks ha_call_service when requireApproval is on', async () => {
    const ctx = await setup({ requireApproval: true })
    const result = await ctx.tools.execute({
      signal,
      callId: CallId('t-gate'),
      name: 'ha_call_service',
      arguments: { domain: 'light', service: 'turn_on', entityId: 'light.living_room' },
    })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('approve to continue')
  })

  it('the approval gate blocks ha_render_template when requireApproval is on', async () => {
    const ctx = await setup({ requireApproval: true })
    const result = await ctx.tools.execute({
      signal,
      callId: CallId('t-tpl-gate'),
      name: 'ha_render_template',
      arguments: { template: "{{ states('sensor.temperature') }}" },
    })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('approve to continue')
  })

  it('allowedDomains denies service calls on other domains', async () => {
    const ctx = await setup({ requireApproval: false, allowedDomains: ['light'] })
    const result = await ctx.tools.execute({
      signal,
      callId: CallId('t-allow'),
      name: 'ha_call_service',
      arguments: { domain: 'switch', service: 'turn_on', entityId: 'switch.boiler' },
    })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('not in allowedDomains')
  })

  it('with approval off, ha_call_service actually calls the API', async () => {
    const calls: Array<{ domain: string; service: string; body: unknown }> = []
    const mock = await startMockHa({ serviceCalls: calls })
    try {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      const fiber = await ctx.plugin({ inject: ['tools'], apply }, {
        baseUrl: `http://127.0.0.1:${mock.port}`,
        token: 't',
        tokenEnv: '',
        timeoutMs: 2000,
        requireApproval: false,
        allowedDomains: [],
        maxHistoryEvents: 100,
        wsEnabled: false,
        eventBufferSize: 50,
      } satisfies Config)
      fibers.push(fiber)
      const result = await ctx.tools.execute({
        signal,
        callId: CallId('t-call'),
        name: 'ha_call_service',
        arguments: {
          domain: 'light',
          service: 'turn_on',
          entityId: 'light.living_room',
          data: { brightness: 128 },
        },
      })
      expect(result.isError).toBe(false)
      expect((result.value as { ok?: boolean }).ok).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0]!.domain).toBe('light')
      expect(calls[0]!.service).toBe('turn_on')
      expect(calls[0]!.body).toEqual({ entity_id: ['light.living_room'], brightness: 128 })
    } finally {
      mock.server.close()
    }
  })

  it('ha_call_service targets an area via area_id in the request body', async () => {
    const calls: Array<{ domain: string; service: string; body: unknown }> = []
    const mock = await startMockHa({ serviceCalls: calls })
    try {
      const ctx = await setup({
        baseUrl: `http://127.0.0.1:${mock.port}`,
        requireApproval: false,
        wsEnabled: false,
      })
      const result = await ctx.tools.execute({
        signal,
        callId: CallId('t-area'),
        name: 'ha_call_service',
        arguments: { domain: 'light', service: 'turn_off', areaId: 'living_room' },
      })
      expect(result.isError).toBe(false)
      expect((result.value as { target?: string }).target).toBe('area:living_room')
      expect(calls).toHaveLength(1)
      expect(calls[0]!.body).toEqual({ area_id: 'living_room' })
    } finally {
      mock.server.close()
    }
  })

  it('ha_call_service targets a device via device_id in the request body', async () => {
    const calls: Array<{ domain: string; service: string; body: unknown }> = []
    const mock = await startMockHa({ serviceCalls: calls })
    try {
      const ctx = await setup({
        baseUrl: `http://127.0.0.1:${mock.port}`,
        requireApproval: false,
        wsEnabled: false,
      })
      const result = await ctx.tools.execute({
        signal,
        callId: CallId('t-device'),
        name: 'ha_call_service',
        arguments: { domain: 'switch', service: 'turn_on', deviceId: 'abc123' },
      })
      expect(result.isError).toBe(false)
      expect((result.value as { target?: string }).target).toBe('device:abc123')
      expect(calls[0]!.body).toEqual({ device_id: 'abc123' })
    } finally {
      mock.server.close()
    }
  })
})

describe('WebSocket-backed tools against the demo emulator', () => {
  // Imported in-process (the harness sandbox cannot spawn child node processes
  // from the vitest worker; in-process import is also CI-proof).
  let emuPort: number
  let emu: { stop: () => void } | undefined

  async function startEmulator(): Promise<void> {
    emuPort = 19000 + Math.floor(Math.random() * 1000)
    // The emulator reads its port from argv[2] at import time.
    process.argv[2] = String(emuPort)
    emu = (await import('../scripts/demo-ha.mjs')) as { stop: () => void }
    for (let i = 0; i < 50; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${emuPort}/api/`, {
          headers: { Authorization: 'Bearer demo-token' },
        })
        if (res.ok) return
      } catch { /* not up yet */ }
      await new Promise(r => setTimeout(r, 100))
    }
    throw new Error('demo emulator did not start')
  }

  async function waitForWs(ctx: Context, want: string, timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const res = await ctx.tools.execute({
        signal,
        callId: CallId('t-ws-poll'),
        name: 'ha_health',
        arguments: {},
      })
      if (!res.isError && (res.value as { websocket?: string }).websocket === want) return
      await new Promise(r => setTimeout(r, 200))
    }
    throw new Error(`WebSocket did not reach "${want}"`)
  }

  it('lists areas, buffers live state changes, and targets areas', async () => {
    await startEmulator()
    try {
      const ctx = await setup({
        baseUrl: `http://127.0.0.1:${emuPort}`,
        token: 'demo-token',
        requireApproval: false,
      })
      // 1. WebSocket connects (real HA-style WS handshake against the emulator).
      await waitForWs(ctx, 'connected')

      // 2. ha_list_areas reads the area registry over WS.
      const areas = await ctx.tools.execute({
        signal,
        callId: CallId('t-areas'),
        name: 'ha_list_areas',
        arguments: {},
      })
      expect(areas.isError).toBe(false)
      const areaList = (areas.value as { areas: { area_id: string; name: string }[] }).areas
      expect(areaList.some(a => a.area_id === 'living_room')).toBe(true)
      expect(areaList.some(a => a.area_id === 'bedroom')).toBe(true)

      // 3. Turn on the bedroom light via REST; the emulator broadcasts
      //    state_changed over WS into the plugin's event buffer.
      await fetch(`http://127.0.0.1:${emuPort}/api/services/light/turn_on`, {
        method: 'POST',
        headers: { Authorization: 'Bearer demo-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity_id: ['light.bedroom'], brightness: 200 }),
      })

      let events: { entity_id: string; state: string }[] = []
      const deadline = Date.now() + 8000
      while (Date.now() < deadline) {
        const res = await ctx.tools.execute({
          signal,
          callId: CallId('t-events'),
          name: 'ha_events',
          arguments: {},
        })
        events = (res.value as { events: { entity_id: string; state: string }[] }).events
        if (events.some(e => e.entity_id === 'light.bedroom' && e.state === 'on')) break
        await new Promise(r => setTimeout(r, 200))
      }
      expect(events.some(e => e.entity_id === 'light.bedroom' && e.state === 'on')).toBe(true)

      // 4. Area targeting: call light.turn_off with areaId=bedroom → the
      //    emulator resolves the area and turns off the bedroom light.
      const call = await ctx.tools.execute({
        signal,
        callId: CallId('t-area-off'),
        name: 'ha_call_service',
        arguments: { domain: 'light', service: 'turn_off', areaId: 'bedroom' },
      })
      expect(call.isError).toBe(false)
      expect((call.value as { target?: string }).target).toBe('area:bedroom')

      const state = await ctx.tools.execute({
        signal,
        callId: CallId('t-area-state'),
        name: 'ha_get_state',
        arguments: { entityId: 'light.bedroom' },
      })
      expect((state.value as { state?: string }).state).toBe('off')
    } finally {
      emu?.stop()
      emu = undefined
    }
  })

  it('degrades gracefully when the WebSocket is unreachable', async () => {
    const ctx = await setup({ wsEnabled: true }) // points at the REST-only mock
    const areas = await ctx.tools.execute({
      signal,
      callId: CallId('t-degrade-areas'),
      name: 'ha_list_areas',
      arguments: {},
    })
    expect(areas.isError).toBe(true)
    expect(textOf(areas)).toMatch(/WebSocket is not connected|WebSocket is unavailable/)
  })
})
