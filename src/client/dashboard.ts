/**
 * Browser-side Conversation Node for the home dashboard.
 *
 * Matches `tool/result` events whose `meta` carries the dashboard snapshot
 * (projected by `ha_dashboard` via `presentationMeta`) and renders a keyed
 * Chat node. Everything rides the KNOWN `tool/result` event type, so the
 * dashboard is durable-safe (no custom session event vocabulary) and
 * replayable from the persisted meta.
 */
import type {
  ConversationContextReader,
  ConversationLocation,
  ConversationMatch,
  ConversationNodeContext,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { DASHBOARD_META_KIND, type DashboardSnapshot } from '../dashboard'

export interface DashboardState {
  readonly snapshot: DashboardSnapshot
  readonly turn: number
  readonly step: number
}

export interface DashboardChatData {
  readonly snapshot: DashboardSnapshot
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    'smarthome-dashboard': DashboardChatData
  }
}

function locationOf(context: ConversationNodeContext): ConversationLocation {
  return context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' }
}

function isDashboardMeta(meta: unknown): meta is DashboardSnapshot {
  return typeof meta === 'object' && meta !== null
    && (meta as { kind?: unknown }).kind === DASHBOARD_META_KIND
}

/**
 * One dashboard call is a single checkpoint event: `ha_dashboard` returns the
 * WHOLE snapshot in `tool/result` meta, so each event carries complete
 * fallback state and no event correlation is needed.
 */
export const dashboardDefinition: ConversationNodeDefinition<DashboardState> = {
  kind: 'smarthome-dashboard',
  target: 'chat',
  match: (event) => {
    if (event.type !== 'tool/result') return null
    if (!isDashboardMeta(event.data.meta)) return null
    const block = event.data.message.content[0]
    const callId = block !== undefined && block.type === 'tool-result'
      ? String(block.toolCallId)
      : String(event.seq)
    return { id: callId, role: 'start' }
  },
  start: (_context, match, _reader: ConversationContextReader) => {
    if (match.event.type !== 'tool/result' || !isDashboardMeta(match.event.data.meta)) {
      throw new Error('smarthome-dashboard requires a tool/result carrying dashboard meta')
    }
    return {
      turn: match.event.data.turn,
      step: match.event.data.step,
      snapshot: match.event.data.meta,
    }
  },
  update: (context) => context.state,
  publication: () => 'immediate',
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    return {
      key: context.key,
      kind: 'smarthome-dashboard',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start?.event.seq ?? context.matches[0]?.event.seq ?? 0,
      location: locationOf(context),
      visibility: 'visible',
      data: { snapshot: context.state.snapshot },
    }
  },
}

// Type-only presence: the slot map declaration lives in the conversation UI
// package; keep it in the program so the slot registration below types.
export type { ChatNodeViewProps }
