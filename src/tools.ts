import type { Context } from '@deepseek-ai/cordis'
import {
  defineTool,
  type GenericCallView,
  type GenericResultView,
  type JsonValue,
} from '@deepseek-ai/dsh-tools'
import type { Config } from './config'
import { HomeAssistantClient, HomeAssistantWsClient, type HaState } from './ha'
import { DASHBOARD_META_KIND, type DashboardSnapshot } from './dashboard'

/** Text content block helper for `output.render` / card content. */
function text(value: string): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: value }]
}

/** Summarize one state without dumping the whole attribute map. */
function summarizeState(state: HaState): string {
  const attrs = state.attributes
  const bits: string[] = []
  for (const key of ['friendly_name', 'unit_of_measurement']) {
    const v = attrs[key]
    if (typeof v === 'string') bits.push(`${key}=${v}`)
  }
  const extra = bits.length ? ` (${bits.join(', ')})` : ''
  return `${state.entity_id}: ${state.state}${extra}`
}

/** Cap rendered text at a sane size so huge attribute maps cannot flood context. */
function truncate(value: string, max = 4000): string {
  return value.length > max ? `${value.slice(0, max)}…[truncated]` : value
}

/**
 * Register the `ha_*` tools. Reads are cheap and safe; the powerful tools
 * (`ha_call_service`, `ha_render_template`) are gated by the plugin's
 * `tools/pre-execute` policy in index.ts. WebSocket-backed tools
 * (`ha_list_areas`, `ha_events`) degrade gracefully when the socket is down.
 */
export function registerTools(
  ctx: Context,
  client: HomeAssistantClient,
  ws: HomeAssistantWsClient,
  config: Config,
): void {
  ctx.tools.register(defineTool({
    name: 'ha_health',
    description:
      'Check the connection to Home Assistant and return instance info ' +
      '(location name, version, timezone, unit system) plus WebSocket status. ' +
      'Call this first to verify the plugin is configured.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          reachable: { type: 'boolean' },
          location: { type: 'string' },
          version: { type: 'string' },
          timezone: { type: 'string' },
          websocket: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value as { reachable?: boolean; location?: string; version?: string; timezone?: string; websocket?: string }
        return text(
          v.reachable
            ? `Home Assistant reachable: "${v.location}" (version ${v.version ?? 'unknown'}, timezone ${v.timezone ?? 'unknown'}, websocket ${v.websocket ?? 'n/a'})`
            : 'Home Assistant unreachable',
        )
      },
    },
    async execute() {
      const message = await client.health()
      if (typeof message !== 'string' || !message.includes('API running')) {
        throw new Error(`Unexpected Home Assistant response: ${JSON.stringify(message)}`)
      }
      const configInfo = await client.getConfig()
      return {
        reachable: true,
        location: configInfo.location_name ?? '',
        version: configInfo.version ?? '',
        timezone: configInfo.time_zone ?? '',
        websocket: ws.status,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ha_list_entities',
    description:
      'List Home Assistant entities, optionally filtered by domain (light, switch, sensor, …) ' +
      'and/or a text query on entity id or friendly name. Returns compact summaries to keep context small.',
    parameters: {
      domain: { type: 'string', description: 'Entity domain filter, e.g. "light" or "sensor"' },
      query: { type: 'string', description: 'Text search over entity id and friendly name' },
      limit: { type: 'number', description: 'Maximum entities to return' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          count: { type: 'number' },
          entities: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                entity_id: { type: 'string' },
                state: { type: 'string' },
                friendly_name: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const lines = (value.entities as { entity_id: string; state: string; friendly_name?: string }[])
          .map(e => `- ${e.entity_id}: ${e.state}${e.friendly_name ? ` (${e.friendly_name})` : ''}`)
        return text(truncate(lines.join('\n') || '(no entities)'))
      },
    },
    async execute(args) {
      const limit = Math.min(Math.max(args.limit ?? 50, 1), 200)
      const states = await client.getStates()
      const query = (args.query ?? '').toLowerCase()
      const filtered = states
        .filter(s => !args.domain || s.entity_id.startsWith(`${args.domain}.`))
        .filter(s => !query ||
          s.entity_id.toLowerCase().includes(query) ||
          String(s.attributes.friendly_name ?? '').toLowerCase().includes(query))
        .sort((a, b) => a.entity_id.localeCompare(b.entity_id))
        .slice(0, limit)
      return {
        count: filtered.length,
        entities: filtered.map(s => ({
          entity_id: s.entity_id,
          state: s.state,
          friendly_name: typeof s.attributes.friendly_name === 'string'
            ? s.attributes.friendly_name
            : '',
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ha_get_state',
    description:
      'Get the full state of one Home Assistant entity, including its attributes ' +
      '(brightness, temperature, battery level, …).',
    parameters: {
      entityId: { type: 'string', required: true, description: 'Entity id, e.g. "light.living_room"' },
    },
    output: {
      // The full raw state object; keep it unconstrained so every attribute
      // HA returns survives round-trip.
      schema: { type: 'json' },
      render: (_args, value) => {
        const s = value as unknown as HaState
        return text(truncate(`${s.entity_id}: ${s.state}\n${JSON.stringify(s.attributes ?? {}, null, 2)}`))
      },
    },
    async execute(args) {
      const s = await client.getState(args.entityId)
      return {
        entity_id: s.entity_id,
        state: s.state,
        attributes: s.attributes,
        last_changed: s.last_changed,
        last_updated: s.last_updated,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ha_history',
    description:
      'Query Home Assistant state history for one entity (or all entities) over a time window. ' +
      'Returns a compact timeline of state changes. Defaults to the last hour.',
    parameters: {
      entityId: { type: 'string', description: 'Entity id filter; omit for all entities' },
      start: { type: 'string', description: 'ISO 8601 start time; defaults to one hour ago' },
      end: { type: 'string', description: 'ISO 8601 end time' },
      maxEvents: { type: 'number', description: 'Maximum timeline entries to return' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          count: { type: 'number' },
          events: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                entity_id: { type: 'string' },
                state: { type: 'string' },
                last_changed: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const events = value.events as { entity_id: string; state: string; last_changed: string }[]
        const lines = events.map(e => `- ${e.last_changed}  ${e.entity_id}: ${e.state}`)
        return text(truncate(lines.join('\n') || '(no history)'))
      },
    },
    async execute(args) {
      const periods = await client.getHistory({
        start: args.start,
        end: args.end,
        entityId: args.entityId,
      })
      const maxEvents = Math.min(Math.max(args.maxEvents ?? config.maxHistoryEvents, 1), 1000)
      const events = periods
        .flat()
        .map(s => ({ entity_id: s.entity_id, state: s.state, last_changed: s.last_changed }))
        .slice(0, maxEvents)
      return { count: events.length, events }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ha_call_service',
    description:
      'Call a Home Assistant service, e.g. light.turn_on, switch.turn_off, climate.set_temperature. ' +
      'Target by entity id(s), by area (areaId — affects everything in that room), or by device (deviceId). ' +
      'Requires human approval (configurable). Use ha_list_entities / ha_list_areas first.',
    parameters: {
      domain: { type: 'string', required: true, description: 'Service domain, e.g. "light"' },
      service: { type: 'string', required: true, description: 'Service name, e.g. "turn_on"' },
      entityId: { type: 'string', description: 'Target a single entity, e.g. "light.living_room"' },
      entityIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Target multiple entities (takes precedence over entityId)',
      },
      areaId: { type: 'string', description: 'Target every device in an area, e.g. "living_room" (see ha_list_areas)' },
      deviceId: { type: 'string', description: 'Target a device, e.g. "a1b2c3…"' },
      data: {
        type: 'object',
        additionalProperties: true,
        description: 'Service data, e.g. {"brightness": 128} or {"temperature": 21}',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          domain: { type: 'string' },
          service: { type: 'string' },
          target: { type: 'string' },
          data: { type: 'json' },
        },
      },
      render: (_args, value) => {
        const target = (value.target as string) || '(whole domain)'
        return text(`Called ${value.domain}.${value.service} on ${target}${value.data ? ` with ${JSON.stringify(value.data)}` : ''}.`)
      },
      // UI cards for the pending and completed call.
    },
    presentCall(args): GenericCallView | undefined {
      const a = args as { domain?: string; service?: string }
      if (!a.domain || !a.service) return undefined
      return { card: 'generic', title: `${a.domain}.${a.service}`, kind: 'execute' }
    },
    presentResult(_args, result): GenericResultView | undefined {
      return {
        card: 'generic',
        content: result.isError
          ? result.content
          : [{ type: 'text', text: '✅ Service call completed' }],
      }
    },
    async execute(args) {
      const entityIds = args.entityIds?.length
        ? args.entityIds
        : (args.entityId ? [args.entityId] : [])
      // HA service bodies accept entity_id | area_id | device_id.
      const target: Record<string, unknown> | undefined = entityIds.length
        ? { entity_id: entityIds }
        : (args.areaId
            ? { area_id: args.areaId }
            : (args.deviceId ? { device_id: args.deviceId } : undefined))
      const label = entityIds.length
        ? entityIds.join(', ')
        : (args.areaId ? `area:${args.areaId}` : (args.deviceId ? `device:${args.deviceId}` : ''))
      await client.callService(args.domain, args.service, target, args.data ?? undefined)
      return {
        ok: true,
        domain: args.domain,
        service: args.service,
        target: label,
        data: (args.data ?? null) as JsonValue,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ha_list_areas',
    description:
      'List Home Assistant areas (rooms) via the WebSocket API. ' +
      'Use the returned area_id with ha_call_service to control everything in a room at once.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          count: { type: 'number' },
          areas: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                area_id: { type: 'string' },
                name: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const areas = value.areas as { area_id: string; name: string }[]
        return text(areas.length
          ? areas.map(a => `- ${a.area_id}: ${a.name}`).join('\n')
          : '(no areas)')
      },
    },
    async execute() {
      const areas = await ws.listAreas()
      return {
        count: areas.length,
        areas: areas.map(a => ({ area_id: a.area_id, name: a.name })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ha_events',
    description:
      'Return recent real-time state changes buffered from the Home Assistant WebSocket ' +
      '(entity, state, previous state, timestamp). Empty when WebSocket is not connected.',
    parameters: {
      limit: { type: 'number', description: 'Maximum events to return' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          count: { type: 'number' },
          websocket: { type: 'string' },
          events: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                entity_id: { type: 'string' },
                state: { type: 'string' },
                old_state: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                last_changed: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const events = value.events as { entity_id: string; state: string; old_state: string; last_changed: string }[]
        const lines = events.map(e => `- ${e.last_changed}  ${e.entity_id}: ${e.old_state ?? '—'} → ${e.state}`)
        return text(truncate(lines.join('\n') || '(no recent events)'))
      },
    },
    async execute(args) {
      const limit = Math.min(Math.max(args.limit ?? 20, 1), 200)
      const events = ws.events.slice(-limit).map(e => ({
        entity_id: e.entity_id,
        state: e.state,
        old_state: e.old_state,
        last_changed: e.last_changed,
      }))
      return { count: events.length, websocket: ws.status, events }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ha_render_template',
    description:
      'Render a Home Assistant Jinja2 template server-side and return the result. ' +
      'Powerful: can evaluate sensor states, calculations, and comparisons. Requires approval (configurable).',
    parameters: {
      template: { type: 'string', required: true, description: 'Jinja2 template, e.g. "{{ states(\'sensor.temperature\') }}"' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          template: { type: 'string' },
          rendered: { type: 'string' },
        },
      },
      render: (_args, value) => text(truncate(`Rendered: ${value.rendered}`)),
    },
    async execute(args) {
      const rendered = await client.renderTemplate(args.template)
      return { template: args.template, rendered }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ha_list_scenes',
    description:
      'List Home Assistant scenes (one-click moods like "cinema", "goodnight", "away"). ' +
      'Activate one with ha_call_service: domain "scene", service "turn_on", entityId the scene entity id.',
    parameters: {
      query: { type: 'string', description: 'Optional text search over scene id or friendly name' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          count: { type: 'number' },
          scenes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                entity_id: { type: 'string' },
                state: { type: 'string' },
                friendly_name: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const scenes = value.scenes as { entity_id: string; friendly_name: string }[]
        return text(scenes.length
          ? scenes.map(s => `- ${s.entity_id}: ${s.friendly_name || s.entity_id}`).join('\n')
          : '(no scenes)')
      },
    },
    async execute(args) {
      const states = await client.getStates()
      const query = (args.query ?? '').toLowerCase()
      const scenes = states
        .filter(s => s.entity_id.startsWith('scene.'))
        .filter(s => !query ||
          s.entity_id.toLowerCase().includes(query) ||
          String(s.attributes.friendly_name ?? '').toLowerCase().includes(query))
        .sort((a, b) => a.entity_id.localeCompare(b.entity_id))
        .map(s => ({
          entity_id: s.entity_id,
          state: s.state,
          friendly_name: typeof s.attributes.friendly_name === 'string'
            ? s.attributes.friendly_name
            : '',
        }))
      return { count: scenes.length, scenes }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ha_dashboard',
    description:
      'Build a full home dashboard snapshot: every entity (grouped by domain, with ' +
      'friendly names, states and units), all scenes, and recent state changes. ' +
      'The result renders as a home dashboard card in the Web UI.',
    parameters: {},
    output: {
      // The canonical value IS the durable snapshot; it is also projected onto
      // `tool/result` meta (presentationMeta) so the browser dashboard node can
      // render it on live streaming AND on session-log replay.
      schema: { type: 'json' },
      render: (_args, value) => {
        const s = value as unknown as DashboardSnapshot
        const on = s.entities.filter(e => e.state === 'on').length
        return text(
          `Dashboard snapshot: ${s.entities.length} entities (${on} on), ` +
          `${s.scenes.length} scenes, ${s.events.length} recent changes.`,
        )
      },
      presentationMeta: (_args, value) => value as JsonValue,
    },
    presentResult(_args, result): GenericResultView | undefined {
      return {
        card: 'generic',
        content: result.isError
          ? result.content
          : [{ type: 'text', text: '🏠 Home dashboard ready' }],
      }
    },
    async execute() {
      const states = await client.getStates()
      const scenes = states
        .filter(s => s.entity_id.startsWith('scene.'))
        .map(s => ({
          entity_id: s.entity_id,
          friendly_name: typeof s.attributes.friendly_name === 'string'
            ? s.attributes.friendly_name
            : s.entity_id,
        }))
        .sort((a, b) => a.entity_id.localeCompare(b.entity_id))
      const entities: DashboardSnapshot['entities'] = states
        .filter(s => !s.entity_id.startsWith('scene.'))
        .sort((a, b) => a.entity_id.localeCompare(b.entity_id))
        .map(s => ({
          entity_id: s.entity_id,
          state: s.state,
          friendly_name: typeof s.attributes.friendly_name === 'string'
            ? s.attributes.friendly_name
            : s.entity_id,
          ...(typeof s.attributes.unit_of_measurement === 'string'
            ? { unit: s.attributes.unit_of_measurement }
            : {}),
        }))
      const events = ws.events.slice(-8).map(e => ({
        entity_id: e.entity_id,
        state: e.state,
        old_state: e.old_state,
        last_changed: e.last_changed,
      }))
      const snapshot: DashboardSnapshot = {
        kind: DASHBOARD_META_KIND,
        generatedAt: new Date().toISOString(),
        entities,
        scenes,
        events,
      }
      return snapshot
    },
  }))
}
