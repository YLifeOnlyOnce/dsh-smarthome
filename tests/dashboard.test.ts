import { describe, expect, it } from 'vitest'
import { dashboardDefinition } from '../src/client/dashboard'
import { DASHBOARD_META_KIND, type DashboardSnapshot } from '../src/dashboard'
import type { ConversationMatch, ConversationNodeContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'

const reader = { previous: () => undefined } as never

function snapshot(overrides: Partial<DashboardSnapshot> = {}): DashboardSnapshot {
  return {
    kind: DASHBOARD_META_KIND,
    generatedAt: '2026-08-14T10:00:00.000Z',
    entities: [
      { entity_id: 'light.living_room', state: 'on', friendly_name: 'Living Room Light', unit: '' },
      { entity_id: 'sensor.temperature', state: '22.5', friendly_name: 'Temperature', unit: '°C' },
    ],
    scenes: [{ entity_id: 'scene.cinema', friendly_name: 'Cinema Mode' }],
    events: [
      { entity_id: 'light.bedroom', state: 'on', old_state: 'off', last_changed: '2026-08-14T09:59:00.000Z' },
    ],
    ...overrides,
  }
}

function toolResultEvent(meta: unknown, callId = 'call-1'): SessionEvent {
  return {
    type: 'tool/result',
    seq: 42,
    time: 0,
    data: {
      turn: 2,
      step: 3,
      message: {
        role: 'user',
        id: 'm-1',
        content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'ok' }] }],
        source: { kind: 'tool' },
      },
      meta,
    },
  } as unknown as SessionEvent
}

function matchOf(event: SessionEvent): ConversationMatch {
  return { role: 'start', event, view: undefined, location: { kind: 'unresolved' } }
}

function contextOf<State>(event: SessionEvent, id: string, state: State | undefined): ConversationNodeContext<State> {
  return {
    key: `k-${id}`,
    id,
    kind: 'smarthome-dashboard',
    state,
    start: { event, match: matchOf(event), view: undefined, location: { kind: 'unresolved' } },
    matches: [matchOf(event)],
  } as unknown as ConversationNodeContext<State>
}

describe('smarthome-dashboard conversation node', () => {
  it('matches a tool/result event carrying dashboard meta', () => {
    const match = dashboardDefinition.match(toolResultEvent(snapshot()))
    expect(match).toEqual({ id: 'call-1', role: 'start' })
  })

  it('ignores tool/result events without dashboard meta', () => {
    expect(dashboardDefinition.match(toolResultEvent({ kind: 'other' }))).toBeNull()
    expect(dashboardDefinition.match(toolResultEvent(undefined))).toBeNull()
    expect(dashboardDefinition.match({ type: 'user/message', seq: 1, time: 0, data: {} } as unknown as SessionEvent)).toBeNull()
  })

  it('start builds the full state from the checkpoint meta', () => {
    const event = toolResultEvent(snapshot())
    const match = dashboardDefinition.match(event)!
    const state = dashboardDefinition.start!(
      contextOf<import('../src/client/dashboard').DashboardState>(event, match.id, undefined),
      matchOf(event),
      reader,
    )
    expect(state.snapshot.entities).toHaveLength(2)
    expect(state.snapshot.kind).toBe(DASHBOARD_META_KIND)
    expect(state.turn).toBe(2)
    expect(state.step).toBe(3)
  })

  it('buildViewNode publishes renderer-ready chat data', () => {
    const event = toolResultEvent(snapshot())
    const match = dashboardDefinition.match(event)!
    const state = dashboardDefinition.start!(contextOf<import('../src/client/dashboard').DashboardState>(event, match.id, undefined), matchOf(event), reader)
    const node = dashboardDefinition.buildViewNode!(contextOf(event, match.id, state))
    expect(node).not.toBeNull()
    expect(node!.kind).toBe('smarthome-dashboard')
    expect((node!.data as { snapshot: { entities: { entity_id: string }[] } }).snapshot.entities[0]!.entity_id)
      .toBe('light.living_room')
  })

  it('stays visible with the same key across updates', () => {
    const event = toolResultEvent(snapshot())
    const match = dashboardDefinition.match(event)!
    const state = dashboardDefinition.start!(
      contextOf<import('../src/client/dashboard').DashboardState>(event, match.id, undefined),
      matchOf(event),
      reader,
    )
    const ctx = contextOf(event, match.id, state) as ConversationNodeContext<import('../src/client/dashboard').DashboardState> & {
      state: import('../src/client/dashboard').DashboardState
    }
    const updated = dashboardDefinition.update!(ctx, matchOf(event))
    expect(updated).toBe(state) // whole-value checkpoint: update is identity
  })
})
