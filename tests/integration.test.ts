import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { apply } from '../src/index'
import type { Config } from '../src/config'
import { startMockHa } from './mock-ha'

const signal = new AbortController().signal

/**
 * Boot the REAL tool runtime (published @deepseek-ai packages) and mount our
 * plugin on it — the same way the harness loads it. This exercises
 * registration, argument validation, the tools/pre-execute approval gate,
 * and execution end-to-end, with no real Home Assistant required.
 */
async function setup(overrides: Partial<Config> = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  apply(ctx, {
    baseUrl: `http://127.0.0.1:${port}`,
    token: 'test-token',
    tokenEnv: '',
    timeoutMs: 2000,
    requireApproval: true,
    allowedDomains: [],
    maxHistoryEvents: 100,
    ...overrides,
  })
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

afterAll(() => {
  server.close()
})

describe('dsh-smarthome in the real tool runtime', () => {
  it('registers all six ha_* tools', async () => {
    const ctx = await setup()
    const names = ctx.tools.schemas().map(s => s.name).sort()
    expect(names).toEqual([
      'ha_call_service',
      'ha_get_state',
      'ha_health',
      'ha_history',
      'ha_list_entities',
      'ha_render_template',
    ])
  })

  it('ha_health reaches the mock and returns instance info', async () => {
    const ctx = await setup()
    const result = await ctx.tools.execute({
      signal,
      callId: CallId('t-health'),
      name: 'ha_health',
      arguments: {},
    })
    expect(result.isError).toBe(false)
    expect((result.value as { reachable?: boolean }).reachable).toBe(true)
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
      apply(ctx, {
        baseUrl: `http://127.0.0.1:${mock.port}`,
        token: 't',
        tokenEnv: '',
        timeoutMs: 2000,
        requireApproval: false,
        allowedDomains: [],
        maxHistoryEvents: 100,
      })
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
})
