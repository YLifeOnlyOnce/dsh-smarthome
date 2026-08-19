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
  it('registers all fourteen ha_* tools', async () => {
    const ctx = await setup()
    const names = ctx.tools.schemas().map(s => s.name).sort()
    expect(names).toEqual([
      'ha_call_service',
      'ha_dashboard',
      'ha_events',
      'ha_get_state',
      'ha_health',
      'ha_history',
      'ha_list_areas',
      'ha_list_devices',
      'ha_list_entities',
      'ha_list_scenes',
      'ha_notify',
      'ha_render_template',
      'ha_wait_for_state',
      'ha_weather',
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

  it('ha_call_service data can never override the computed target', async () => {
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
        callId: CallId('t-data-safety'),
        name: 'ha_call_service',
        arguments: {
          domain: 'light',
          service: 'turn_on',
          entityId: 'light.living_room',
          // A mistaken/hostile model could put a target key inside `data`;
          // it must not retarget the call.
          data: { entity_id: 'switch.boiler', brightness: 128 },
        },
      })
      expect(result.isError).toBe(false)
      expect(calls[0]!.body).toEqual({ entity_id: ['light.living_room'], brightness: 128 })
      expect((result.value as { data: { entity_id?: unknown } }).data.entity_id).toBeUndefined()
    } finally {
      mock.server.close()
    }
  })

  it('ha_render_template succeeds when approval is off', async () => {
    const ctx = await setup({ requireApproval: false })
    const result = await ctx.tools.execute({
      signal,
      callId: CallId('t-tpl-ok'),
      name: 'ha_render_template',
      arguments: { template: "{{ states('sensor.temperature') }}" },
    })
    expect(result.isError).toBe(false)
    expect((result.value as { rendered: string }).rendered).toContain('sensor.temperature')
  })

  it('ha_history returns the state-change timeline', async () => {
    const ctx = await setup()
    const result = await ctx.tools.execute({
      signal,
      callId: CallId('t-history'),
      name: 'ha_history',
      arguments: { entityId: 'light.living_room' },
    })
    expect(result.isError).toBe(false)
    const events = (result.value as { events: { entity_id: string }[] }).events
    expect(events.length).toBeGreaterThan(0)
    expect(events[0]!.entity_id).toBe('light.living_room')
  })
})

describe('WebSocket-backed tools against the demo emulator', () => {
  // Imported in-process (the harness sandbox cannot spawn child node processes
  // from the vitest worker; in-process import is also CI-proof). The emulator
  // module runs its top-level `listen` exactly once (ESM caches modules), so it
  // is started once for the whole describe and shared by the tests below.
  let emuPort: number
  let emu: { stop: () => void } | undefined

  beforeAll(async () => {
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
  })

  afterAll(() => {
    emu?.stop()
    emu = undefined
  })

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
  }, 20000)

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

  it('lists scenes and activates one — the emulator cascades the whole mood', async () => {
    const ctx = await setup({
      baseUrl: `http://127.0.0.1:${emuPort}`,
      token: 'demo-token',
      requireApproval: false,
    })
    // Make sure THIS plugin's WebSocket is subscribed before the cascade, or
    // its ha_events buffer would miss the state_changed broadcasts.
    await waitForWs(ctx, 'connected')

      // 1. ha_list_scenes finds the demo scenes.
      const scenes = await ctx.tools.execute({
        signal,
        callId: CallId('t-scenes'),
        name: 'ha_list_scenes',
        arguments: {},
      })
      expect(scenes.isError).toBe(false)
      const sceneList = (scenes.value as { scenes: { entity_id: string; friendly_name: string }[] }).scenes
      expect(sceneList.map(s => s.entity_id).sort()).toEqual([
        'scene.away',
        'scene.cinema',
        'scene.goodnight',
      ])

      // 2. Activate "cinema" via the ordinary service-call tool.
      const activate = await ctx.tools.execute({
        signal,
        callId: CallId('t-scene-on'),
        name: 'ha_call_service',
        arguments: { domain: 'scene', service: 'turn_on', entityId: 'scene.cinema' },
      })
      expect(activate.isError).toBe(false)

      // 3. The cascade landed: dimmed living-room light, TV on, bedroom off.
      const livingRoom = await ctx.tools.execute({
        signal,
        callId: CallId('t-scene-lr'),
        name: 'ha_get_state',
        arguments: { entityId: 'light.living_room' },
      })
      const lr = livingRoom.value as { state?: string; attributes?: { brightness?: number } }
      expect(lr.state).toBe('on')
      expect(lr.attributes?.brightness).toBe(40)

      const tv = await ctx.tools.execute({
        signal,
        callId: CallId('t-scene-tv'),
        name: 'ha_get_state',
        arguments: { entityId: 'media_player.tv' },
      })
      expect((tv.value as { state?: string }).state).toBe('on')

      const bedroom = await ctx.tools.execute({
        signal,
        callId: CallId('t-scene-br'),
        name: 'ha_get_state',
        arguments: { entityId: 'light.bedroom' },
      })
      expect((bedroom.value as { state?: string }).state).toBe('off')

      // 4. The whole cascade is visible in the real-time event feed.
      const events = await ctx.tools.execute({
        signal,
        callId: CallId('t-scene-events'),
        name: 'ha_events',
        arguments: {},
      })
      const eventList = (events.value as { events: { entity_id: string }[] }).events
      expect(eventList.some(e => e.entity_id === 'media_player.tv')).toBe(true)
  }, 20000)

  it('ha_dashboard builds a full snapshot and projects it onto tool/result meta', async () => {
    const ctx = await setup({
      baseUrl: `http://127.0.0.1:${emuPort}`,
      token: 'demo-token',
      requireApproval: false,
    })
    await waitForWs(ctx, 'connected')

    // Trigger one live change so the snapshot's event feed is non-empty.
    await fetch(`http://127.0.0.1:${emuPort}/api/services/switch/turn_on`, {
      method: 'POST',
      headers: { Authorization: 'Bearer demo-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity_id: ['switch.boiler'] }),
    })
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      const poll = await ctx.tools.execute({
        signal,
        callId: CallId('t-dash-poll'),
        name: 'ha_events',
        arguments: {},
      })
      if ((poll.value as { events: { entity_id: string }[] }).events.some(e => e.entity_id === 'switch.boiler')) break
      await new Promise(r => setTimeout(r, 200))
    }

    const result = await ctx.tools.execute({
      signal,
      callId: CallId('t-dashboard'),
      name: 'ha_dashboard',
      arguments: {},
    })
    expect(result.isError).toBe(false)

    const value = result.value as { entities: { entity_id: string }[]; scenes: { entity_id: string }[]; events: { entity_id: string }[] }
    expect(value.entities.some(e => e.entity_id === 'light.living_room')).toBe(true)
    expect(value.scenes.some(s => s.entity_id === 'scene.cinema')).toBe(true)
    expect(value.events.some(e => e.entity_id === 'switch.boiler')).toBe(true)

    // The same snapshot rides the durable tool/result meta for the browser node.
    expect((result.meta as { kind?: string }).kind).toBe('smarthome-dashboard')
    expect((result.meta as { entities: { entity_id: string }[] }).entities.length)
      .toBe(value.entities.length)
  }, 20000)

  it('lists devices from the registry and targets one via device_id', async () => {
    const ctx = await setup({
      baseUrl: `http://127.0.0.1:${emuPort}`,
      token: 'demo-token',
      requireApproval: false,
    })
    await waitForWs(ctx, 'connected')

    // 1. ha_list_devices reads the WS device registry.
    const list = await ctx.tools.execute({
      signal,
      callId: CallId('t-devices'),
      name: 'ha_list_devices',
      arguments: {},
    })
    expect(list.isError).toBe(false)
    const devices = (list.value as { devices: { id: string; name: string; area_id?: string }[] }).devices
    const light = devices.find(d => d.id === 'dev_living_light')
    expect(light).toBeDefined()
    expect(light!.name).toBe('Living Room Light')
    expect(light!.area_id).toBe('living_room')

    // 2. Filter by area.
    const bedroom = await ctx.tools.execute({
      signal,
      callId: CallId('t-devices-area'),
      name: 'ha_list_devices',
      arguments: { areaId: 'bedroom' },
    })
    const bedroomDevices = (bedroom.value as { devices: { id: string }[] }).devices
    expect(bedroomDevices.map(d => d.id)).toEqual(['dev_bedroom_light'])

    // 3. Device-targeted service call: the emulator resolves device → entities.
    await ctx.tools.execute({
      signal,
      callId: CallId('t-dev-on'),
      name: 'ha_call_service',
      arguments: { domain: 'light', service: 'turn_on', deviceId: 'dev_living_light', data: { brightness: 90 } },
    })
    const state = await ctx.tools.execute({
      signal,
      callId: CallId('t-dev-state'),
      name: 'ha_get_state',
      arguments: { entityId: 'light.living_room' },
    })
    const s = state.value as { state?: string; attributes?: { brightness?: number } }
    expect(s.state).toBe('on')
    expect(s.attributes?.brightness).toBe(90)
  }, 20000)

  it('ha_wait_for_state matches immediately and reports timeout', async () => {
    const ctx = await setup({
      baseUrl: `http://127.0.0.1:${emuPort}`,
      token: 'demo-token',
      requireApproval: false,
    })

    // Immediate match: wait for the boiler's CURRENT state (a previous test
    // may have toggled it), so the first poll hits.
    const currentBoiler = await ctx.tools.execute({
      signal,
      callId: CallId('t-wait-boiler-now'),
      name: 'ha_get_state',
      arguments: { entityId: 'switch.boiler' },
    })
    const boilerState = (currentBoiler.value as { state: string }).state
    const hit = await ctx.tools.execute({
      signal,
      callId: CallId('t-wait-hit'),
      name: 'ha_wait_for_state',
      arguments: { entityId: 'switch.boiler', targetState: boilerState, timeoutMs: 3000, checkIntervalMs: 200 },
    })
    expect(hit.isError).toBe(false)
    expect((hit.value as { matched: boolean; state: string }).matched).toBe(true)
    expect((hit.value as { state: string }).state).toBe(boilerState)

    // Timeout: the light never becomes "nope".
    const miss = await ctx.tools.execute({
      signal,
      callId: CallId('t-wait-miss'),
      name: 'ha_wait_for_state',
      arguments: { entityId: 'light.living_room', targetState: 'nope', timeoutMs: 800, checkIntervalMs: 200 },
    })
    expect(miss.isError).toBe(false) // timeout is a domain outcome, not an error
    expect((miss.value as { matched: boolean }).matched).toBe(false)
  }, 20000)

  it('ha_wait_for_state waits for a real change (temperature drift)', async () => {
    const ctx = await setup({
      baseUrl: `http://127.0.0.1:${emuPort}`,
      token: 'demo-token',
      requireApproval: false,
    })
    const before = await ctx.tools.execute({
      signal,
      callId: CallId('t-wait-temp-before'),
      name: 'ha_get_state',
      arguments: { entityId: 'sensor.temperature' },
    })
    const current = (before.value as { state: string }).state

    // The emulator drifts the temperature every 5s; wait for it to change.
    const wait = await ctx.tools.execute({
      signal,
      callId: CallId('t-wait-temp'),
      name: 'ha_wait_for_state',
      arguments: { entityId: 'sensor.temperature', notTargetState: current, timeoutMs: 12000, checkIntervalMs: 300 },
    })
    expect(wait.isError).toBe(false)
    const v = wait.value as { matched: boolean; state: string }
    expect(v.matched).toBe(true)
    expect(v.state).not.toBe(current)
  }, 25000)

  it('ha_notify sends persistent and service notifications', async () => {
    const ctx = await setup({
      baseUrl: `http://127.0.0.1:${emuPort}`,
      token: 'demo-token',
      requireApproval: false,
    })
    const persistent = await ctx.tools.execute({
      signal,
      callId: CallId('t-notify-1'),
      name: 'ha_notify',
      arguments: { message: 'The washer is done', title: 'Chore' },
    })
    expect(persistent.isError).toBe(false)
    expect((persistent.value as { service: string }).service).toBe('persistent_notification')

    const mobile = await ctx.tools.execute({
      signal,
      callId: CallId('t-notify-2'),
      name: 'ha_notify',
      arguments: { message: 'Front door opened', notifyService: 'mobile_app_my_phone' },
    })
    expect(mobile.isError).toBe(false)
    expect((mobile.value as { service: string }).service).toBe('mobile_app_my_phone')
  }, 20000)

  it('ha_weather returns a structured forecast', async () => {
    const ctx = await setup({
      baseUrl: `http://127.0.0.1:${emuPort}`,
      token: 'demo-token',
      requireApproval: false,
    })
    const result = await ctx.tools.execute({
      signal,
      callId: CallId('t-weather'),
      name: 'ha_weather',
      arguments: { forecastDays: 7 },
    })
    expect(result.isError).toBe(false)
    const v = result.value as { condition?: string; temperature?: number; forecast: unknown[] }
    expect(v.condition).toBe('sunny')
    expect(v.forecast.length).toBe(5) // emulator ships 5 forecast entries
  }, 20000)
})
