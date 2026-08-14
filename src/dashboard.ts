/**
 * Shared dashboard snapshot contract between the host tool (`ha_dashboard`)
 * and the browser client node. Type-only — the client bundle imports it for
 * types only; the marker literal is duplicated deliberately so neither side
 * needs a runtime import of the other.
 */

/** Marker carried on `tool/result` meta to identify a dashboard snapshot. */
export const DASHBOARD_META_KIND = 'smarthome-dashboard' as const

/** One entity in the dashboard snapshot. */
export type DashboardEntity = {
  entity_id: string
  state: string
  friendly_name: string
  unit?: string
}

/** One scene in the dashboard snapshot. */
export type DashboardScene = {
  entity_id: string
  friendly_name: string
}

/** One recent state change in the dashboard snapshot. */
export type DashboardEvent = {
  entity_id: string
  state: string
  old_state: string | null
  last_changed: string
}

/** Full dashboard snapshot persisted on the `tool/result` meta. */
export type DashboardSnapshot = {
  kind: typeof DASHBOARD_META_KIND
  generatedAt: string
  entities: DashboardEntity[]
  scenes: DashboardScene[]
  events: DashboardEvent[]
}
