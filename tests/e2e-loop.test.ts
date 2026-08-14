import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply } from '../src/index'
import { dashboardDefinition } from '../src/client/dashboard'
import { DASHBOARD_META_KIND } from '../src/dashboard'
import { startMockHa } from './mock-ha'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter'

const fibers: Fiber[] = []

/**
 * Full-harness E2E: boot the REAL agent loop (session + system prompt + tool
 * runtime + agent registry + agent loop) exactly like the harness's own
 * tests do, mount dsh-smarthome on it, and drive a complete turn with a
 * scripted LLM adapter. No API key, no real Home Assistant — the demo
 * emulator stands in for HA. This proves the plugin works inside the actual
 * agent loop, not just the tool runtime.
 */
async function fullHarness(adapter: MockAdapter, configOverrides: Record<string, unknown> = {}) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  const fiber = await ctx.plugin({ inject: ['tools'], apply }, {
    baseUrl: `http://127.0.0.1:${port}`,
    token: 'test-token',
    tokenEnv: '',
    timeoutMs: 2000,
    requireApproval: true,
    allowedDomains: [],
    maxHistoryEvents: 100,
    wsEnabled: false,
    eventBufferSize: 50,
    ...configOverrides,
  } satisfies Parameters<typeof apply>[1])
  fibers.push(fiber)
  return ctx
}

async function driveTurn(ctx: Context, sessionId: string, prompt: string): Promise<Agent> {
  const agent = ctx.agentLoop.create(SessionId(sessionId), { provider: 'mock', model: 'mock' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
  await agent.whenIdle()
  return agent
}

interface SessionEventLike {
  type: string
}

let server: Server
let port: number

beforeAll(async () => {
  const mock = await startMockHa()
  server = mock.server
  port = mock.port
})

afterAll(async () => {
  for (const fiber of fibers.splice(0)) await fiber.dispose()
  server.close()
})

describe('dsh-smarthome in the real agent loop', () => {
  it('a full turn: model calls ha_health, gets the real result, and answers', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c-health', 'ha_health', {}),
      textResponse('Home Assistant is reachable.'),
    ])
    const ctx = await fullHarness(adapter)
    const agent = await driveTurn(ctx, 'smarthome-e2e-health', 'Check Home Assistant health.')

    // The loop made exactly two model requests: the tool call and the answer.
    expect(adapter.requests).toHaveLength(2)

    // The rendered tool result reached the model's second request.
    const secondRequest = adapter.requests[1]!
    expect(JSON.stringify(secondRequest.messages)).toContain('Home Assistant reachable')

    // The session logged the tool result and completed the turn.
    const types = (agent.session.events as unknown as SessionEventLike[]).map(e => e.type)
    expect(types).toContain('tool/result')
    expect(types).toContain('turn/end')
  })

  it('the approval gate blocks a service call inside the real loop', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c-call', 'ha_call_service', {
        domain: 'light',
        service: 'turn_on',
        entityId: 'light.living_room',
      }),
      textResponse('The light stays off.'),
    ])
    const ctx = await fullHarness(adapter)
    const agent = await driveTurn(ctx, 'smarthome-e2e-gate', 'Turn on the living room light.')

    expect(adapter.requests).toHaveLength(2)

    // The denial reason from the approval gate reached the model.
    const secondRequest = adapter.requests[1]!
    expect(JSON.stringify(secondRequest.messages)).toContain('approve to continue')

    const types = (agent.session.events as unknown as SessionEventLike[]).map(e => e.type)
    expect(types).toContain('tool/result')
    expect(types).toContain('turn/end')
  })

  it('ha_dashboard renders through the loop and the browser node assembles from its real event', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c-dash', 'ha_dashboard', {}),
      textResponse('Here is your home dashboard.'),
    ])
    const ctx = await fullHarness(adapter)
    const agent = await driveTurn(ctx, 'smarthome-e2e-dashboard', 'Show me my home dashboard.')

    expect(adapter.requests).toHaveLength(2)

    // The dashboard tool result carried the snapshot in its durable meta.
    const toolResult = (agent.session.events as unknown as Array<{
      type: string
      data?: { meta?: { kind?: string } }
    }>).find(e => e.type === 'tool/result' && e.data?.meta?.kind === DASHBOARD_META_KIND)
    expect(toolResult).toBeDefined()

    // The browser conversation node builds a renderer-ready node from that
    // exact real event — live and on replay.
    const match = dashboardDefinition.match(toolResult as never)
    expect(match).not.toBeNull()
    const engineMatch = {
      id: match!.id,
      role: 'start',
      event: toolResult,
      view: undefined,
      location: { kind: 'unresolved' },
    }
    const state = dashboardDefinition.start!({} as never, engineMatch as never, {} as never)
    const node = dashboardDefinition.buildViewNode!({
      key: 'k-dash',
      id: match!.id,
      state,
      start: { event: toolResult },
      matches: [engineMatch],
    } as never)
    expect(node?.kind).toBe('smarthome-dashboard')
    expect((node!.data as { snapshot: { entities: unknown[] } }).snapshot.entities.length).toBeGreaterThan(0)
  })
})
