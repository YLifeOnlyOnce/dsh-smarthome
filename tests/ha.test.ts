import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { HomeAssistantClient, HomeAssistantError } from '../src/ha'
import { startMockHa } from './mock-ha'

let server: Server
let port: number

beforeAll(async () => {
  const mock = await startMockHa()
  server = mock.server
  port = mock.port
})

afterAll(() => {
  server.close()
})

function client(token = 'test-token', timeoutMs = 2000): HomeAssistantClient {
  return new HomeAssistantClient(`http://127.0.0.1:${port}`, token, timeoutMs)
}

describe('HomeAssistantClient', () => {
  it('reports an unconfigured client loudly', async () => {
    const c = new HomeAssistantClient('http://127.0.0.1:1', '', 100)
    await expect(c.health()).rejects.toThrow(/no Home Assistant token/)
  })

  it('health() verifies the connection', async () => {
    await expect(client().health()).resolves.toBe('API running.')
  })

  it('getConfig() returns instance metadata', async () => {
    const cfg = await client().getConfig()
    expect(cfg.location_name).toBe('Test Home')
    expect(cfg.version).toBe('2026.8.0')
    expect(cfg.time_zone).toBe('Asia/Shanghai')
  })

  it('getStates() returns all entities', async () => {
    const states = await client().getStates()
    expect(states).toHaveLength(3)
    expect(states[0]!.entity_id).toBe('light.living_room')
  })

  it('getState() returns one entity with attributes', async () => {
    const s = await client().getState('light.living_room')
    expect(s.state).toBe('on')
    expect(s.attributes.brightness).toBe(128)
  })

  it('getHistory() returns timelines and sends filter params', async () => {
    const periods = await client().getHistory({ entityId: 'light.living_room' })
    expect(periods).toHaveLength(1)
    expect(periods[0]![0]!.state).toBe('off')
  })

  it('callService() posts a typed body to the right route', async () => {
    const calls: Array<{ domain: string; service: string; body: unknown }> = []
    const mock = await startMockHa({ serviceCalls: calls })
    try {
      const c = new HomeAssistantClient(`http://127.0.0.1:${mock.port}`, 't', 2000)
      await c.callService('light', 'turn_on', { entity_id: ['light.living_room'] }, { brightness: 128 })
      expect(calls).toHaveLength(1)
      expect(calls[0]!.domain).toBe('light')
      expect(calls[0]!.service).toBe('turn_on')
      expect(calls[0]!.body).toEqual({ entity_id: ['light.living_room'], brightness: 128 })
    } finally {
      mock.server.close()
    }
  })

  it('renderTemplate() returns the rendered string', async () => {
    const templates: string[] = []
    const mock = await startMockHa({ templates })
    try {
      const c = new HomeAssistantClient(`http://127.0.0.1:${mock.port}`, 't', 2000)
      const out = await c.renderTemplate("{{ states('sensor.temperature') }}")
      expect(templates).toEqual(["{{ states('sensor.temperature') }}"])
      expect(out).toContain('sensor.temperature')
    } finally {
      mock.server.close()
    }
  })

  it('surfaces HTTP errors with status and body', async () => {
    const mock = await startMockHa({ unauthorized: true })
    try {
      const c = new HomeAssistantClient(`http://127.0.0.1:${mock.port}`, 'bad', 2000)
      const err = await c.getStates().then(() => null, (e: unknown) => e)
      expect(err).toBeInstanceOf(HomeAssistantError)
      expect((err as HomeAssistantError).status).toBe(401)
    } finally {
      mock.server.close()
    }
  })

  it('times out after the configured deadline', async () => {
    const mock = await startMockHa({ latencyMs: 300 })
    try {
      const c = new HomeAssistantClient(`http://127.0.0.1:${mock.port}`, 't', 50)
      const err = await c.health().then(() => null, (e: unknown) => e)
      expect(err).toBeInstanceOf(HomeAssistantError)
      expect((err as Error).message).toMatch(/timed out/)
    } finally {
      mock.server.close()
    }
  })
})
