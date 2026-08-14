/**
 * Browser half of dsh-smarthome: renders a pretty home dashboard card into
 * the conversation when `ha_dashboard` runs. Loaded by the Web Client's
 * module loader from the package's `dsh.client` manifest.
 */
import { createElement, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { dashboardDefinition, type DashboardChatData } from './dashboard'
import type { DashboardEntity, DashboardSnapshot } from '../dashboard'

/** Required services: the conversation-node registry and the slots service. */
export const inject = ['conversationEvents', 'slots']

// ---------------------------------------------------------------------------
// Theme (matches the DSH Web dark surface)
// ---------------------------------------------------------------------------
const COLORS = {
  bg: '#12151a',
  card: '#16191e',
  border: '#262b33',
  text: '#e6e9ee',
  muted: '#8b93a1',
  on: '#6ee7b7',
  off: '#4a5160',
  accent: '#4d7cfe',
  warn: '#fbbf24',
  danger: '#f87171',
}

function iconFor(entityId: string): string {
  if (entityId.startsWith('light.')) return '💡'
  if (entityId.startsWith('switch.')) return '🔌'
  if (entityId.startsWith('climate.')) return '❄️'
  if (entityId.startsWith('media_player.')) return '📺'
  if (entityId.startsWith('binary_sensor.')) {
    return entityId.includes('door') ? '🚪' : '📡'
  }
  if (entityId.startsWith('cover.')) return '🪟'
  if (entityId.startsWith('fan.')) return '🌀'
  if (entityId.startsWith('vacuum.')) return '🧹'
  if (entityId.startsWith('lock.')) return '🔒'
  if (entityId.startsWith('camera.')) return '📷'
  if (entityId.startsWith('sensor.')) {
    if (entityId.includes('temp')) return '🌡️'
    if (entityId.includes('humid')) return '💧'
    if (entityId.includes('power') || entityId.includes('energy') || entityId.includes('watt')) return '⚡'
    return '📊'
  }
  return '🏠'
}

function stateColor(state: string): string {
  if (state === 'on') return COLORS.on
  if (state === 'off') return COLORS.off
  if (state === 'unavailable' || state === 'unknown') return COLORS.danger
  return COLORS.accent
}

function shortTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('zh-CN', { hour12: false })
}

const DOMAIN_TITLES: Array<[string, string]> = [
  ['light.', '💡 灯光'],
  ['switch.', '🔌 开关'],
  ['sensor.', '📊 传感器'],
  ['climate.', '❄️ 空调'],
  ['media_player.', '📺 影音'],
  ['binary_sensor.', '🚪 门窗'],
  ['cover.', '🪟 窗帘'],
  ['fan.', '🌀 风扇'],
  ['vacuum.', '🧹 清洁'],
  ['lock.', '🔒 门锁'],
]

function groupEntities(entities: DashboardEntity[]): Array<{ title: string; items: DashboardEntity[] }> {
  const groups = DOMAIN_TITLES.map(([prefix, title]) => ({
    title,
    items: entities.filter(e => e.entity_id.startsWith(prefix)),
  }))
  const others = entities.filter(e => !DOMAIN_TITLES.some(([prefix]) => e.entity_id.startsWith(prefix)))
  if (others.length > 0) groups.push({ title: '🏠 其他', items: others })
  return groups.filter(g => g.items.length > 0)
}

// ---------------------------------------------------------------------------
// Dashboard card
// ---------------------------------------------------------------------------
function EntityRow({ entity }: { entity: DashboardEntity }) {
  const value = entity.state === 'on' || entity.state === 'off'
    ? entity.state
    : `${entity.state}${entity.unit ? ` ${entity.unit}` : ''}`
  return createElement('div', {
    style: {
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '6px 10px', borderRadius: 8, background: COLORS.card,
      border: `1px solid ${COLORS.border}`,
    },
  },
    createElement('span', { style: { fontSize: 15 } }, iconFor(entity.entity_id)),
    createElement('span', {
      style: { flex: 1, color: COLORS.text, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    }, entity.friendly_name || entity.entity_id),
    createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
      createElement('span', { style: { fontSize: 12, color: stateColor(entity.state), fontWeight: 600 } }, value),
      createElement('span', { style: { width: 7, height: 7, borderRadius: '50%', background: stateColor(entity.state) } }),
    ),
  )
}

/**
 * Renders the dashboard card. The prop type is the structural slice of the
 * keyed Chat-node seat (`node.data`), which satisfies both the view contract
 * and the slot component signature without pulling the locale-bound props.
 */
function DashboardView(props: { node: { data: DashboardChatData } }) {
  const { node } = props
  const snapshot: DashboardSnapshot = node.data.snapshot
  const groups = groupEntities(snapshot.entities)
  const onCount = snapshot.entities.filter(e => e.state === 'on').length
  const recentEvents = snapshot.events.slice(-5).reverse()

  return createElement('div', {
    style: {
      background: COLORS.bg, border: `1px solid ${COLORS.border}`, borderRadius: 12,
      padding: '12px 14px', maxWidth: 560, fontFamily: 'system-ui, -apple-system, "PingFang SC", sans-serif',
    },
  },
    // Header
    createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 } },
      createElement('span', { style: { fontSize: 16 } }, '🏠'),
      createElement('span', { style: { color: COLORS.text, fontWeight: 700, fontSize: 14, flex: 1 } }, '家庭仪表盘'),
      createElement('span', { style: { color: COLORS.muted, fontSize: 11 } },
        `${snapshot.entities.length} 个设备 · ${onCount} 在线 · ${shortTime(snapshot.generatedAt)}`),
    ),
    // Scenes
    ...(snapshot.scenes.length > 0 ? [
      createElement('div', { key: 'scenes', style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 } },
        ...snapshot.scenes.map(scene =>
          createElement('span', {
            key: scene.entity_id,
            style: {
              fontSize: 12, color: COLORS.text, background: COLORS.card,
              border: `1px solid ${COLORS.border}`, borderRadius: 99, padding: '3px 10px',
            },
          }, `🎬 ${scene.friendly_name}`)),
      ),
    ] : []),
    // Domain groups
    ...groups.map(group =>
      createElement('div', { key: group.title, style: { marginBottom: 8 } },
        createElement('div', { style: { color: COLORS.muted, fontSize: 11, marginBottom: 4 } }, group.title),
        createElement('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 } },
          ...group.items.map(entity => createElement(EntityRow, { key: entity.entity_id, entity })),
        ),
      ),
    ),
    // Recent changes
    ...(recentEvents.length > 0 ? [
      createElement('div', { key: 'events', style: { marginTop: 8, paddingTop: 8, borderTop: `1px solid ${COLORS.border}` } },
        createElement('div', { style: { color: COLORS.muted, fontSize: 11, marginBottom: 4 } }, '🕐 最近变化'),
        ...recentEvents.map((event, i) =>
          createElement('div', { key: i, style: { color: COLORS.muted, fontSize: 12, display: 'flex', gap: 6 } },
            createElement('span', {}, iconFor(event.entity_id)),
            createElement('span', { style: { flex: 1 } },
              `${event.entity_id}: ${event.old_state ?? '—'} → `,
              createElement('span', { style: { color: stateColor(event.state) } }, event.state)),
            createElement('span', {}, shortTime(event.last_changed)),
          ),
        ),
      ),
    ] : []),
  )
}

// ---------------------------------------------------------------------------
// Client plugin body
// ---------------------------------------------------------------------------
export function apply(ctx: ClientContext & Context): void {
  ctx.conversationEvents.register(dashboardDefinition)
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'smarthome-dashboard',
  }, DashboardView))
}

// Keep the type referenced so the augmentation stays part of the program.
export type { DashboardChatData }
export type { DashboardView as DashboardViewComponent }
export type { ReactNode }
