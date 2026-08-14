#!/usr/bin/env node
/**
 * dsh-smarthome demo emulator — a fake Home Assistant REST API.
 *
 * No real Home Assistant needed: this script serves the endpoints the plugin
 * uses with a small living demo home whose state actually CHANGES when you
 * call services (turn lights on/off, set brightness, adjust the thermostat),
 * plus a temperature sensor that drifts so history queries have fresh data.
 *
 * Usage:
 *   node scripts/demo-ha.mjs [port]        # default port 8124
 *
 * Then configure the plugin:
 *   - id: smarthome
 *     config:
 *       baseUrl: http://127.0.0.1:8124
 *       tokenEnv: HOME_ASSISTANT_TOKEN
 *   HOME_ASSISTANT_TOKEN=demo-token dsh --profile web
 *
 * Any Bearer token is accepted; use `demo-token`.
 */

const PORT = Number(process.argv[2] ?? 8124)

// ---------------------------------------------------------------------------
// Demo home state
// ---------------------------------------------------------------------------

function entity(id, state, attributes) {
  return {
    entity_id: id,
    state,
    attributes,
    last_changed: new Date().toISOString(),
    last_updated: new Date().toISOString(),
  }
}

/** Per-entity history log of { state, last_changed, last_updated }. */
const history = new Map()

// Area registry (WebSocket `config/area_registry/list`) + area → entity map.
const AREAS = [
  { area_id: 'living_room', name: 'Living Room' },
  { area_id: 'bedroom', name: 'Bedroom' },
  { area_id: 'kitchen', name: 'Kitchen' },
]
const AREA_ENTITIES = {
  living_room: ['light.living_room', 'sensor.temperature', 'sensor.humidity', 'climate.thermostat', 'media_player.tv'],
  bedroom: ['light.bedroom'],
  kitchen: [],
}

/** Device registry (WebSocket `config/device_registry/list`) + device → entity map. */
const DEVICE_REGISTRY = [
  { id: 'dev_living_light', name: 'Living Room Light', area_id: 'living_room' },
  { id: 'dev_bedroom_light', name: 'Bedroom Light', area_id: 'bedroom' },
  { id: 'dev_thermostat', name: 'Thermostat', area_id: 'living_room' },
  { id: 'dev_tv', name: 'TV', area_id: 'living_room' },
  { id: 'dev_boiler', name: 'Boiler', area_id: null },
  { id: 'dev_camera', name: 'Front Door Camera', area_id: null },
]
const DEVICE_ENTITIES = {
  dev_living_light: ['light.living_room'],
  dev_bedroom_light: ['light.bedroom'],
  dev_thermostat: ['climate.thermostat'],
  dev_tv: ['media_player.tv'],
  dev_boiler: ['switch.boiler'],
  dev_camera: ['camera.front_door'],
}

/** WebSocket subscribers waiting for state_changed events. */
const wsSubscribers = new Set()

function stateChangedEvent(e, oldState) {
  return {
    type: 'event',
    event: {
      event_type: 'state_changed',
      data: {
        entity_id: e.entity_id,
        new_state: { entity_id: e.entity_id, state: e.state, attributes: e.attributes, last_changed: e.last_changed, last_updated: e.last_updated },
        old_state: oldState,
      },
    },
  }
}

/** Broadcast one state change to every subscribed WebSocket client. */
function broadcastChange(e, oldState) {
  const msg = JSON.stringify(stateChangedEvent(e, oldState))
  for (const ws of wsSubscribers) {
    if (ws.readyState === 1) ws.send(msg)
  }
}

function stamp(e) {
  const now = new Date().toISOString()
  e.last_updated = now
  return now
}

function recordChange(e, oldState) {
  const log = history.get(e.entity_id) ?? []
  log.push({
    entity_id: e.entity_id,
    state: e.state,
    last_changed: e.last_changed,
    last_updated: e.last_updated,
  })
  history.set(e.entity_id, log)
  broadcastChange(e, oldState)
}

const entities = new Map([
  ['light.living_room', entity('light.living_room', 'on', { friendly_name: 'Living Room Light', brightness: 128, color_temp: 280 })],
  ['light.bedroom', entity('light.bedroom', 'off', { friendly_name: 'Bedroom Light' })],
  ['switch.boiler', entity('switch.boiler', 'off', { friendly_name: 'Boiler' })],
  ['sensor.temperature', entity('sensor.temperature', '22.5', { friendly_name: 'Living Room Temperature', unit_of_measurement: '°C' })],
  ['sensor.humidity', entity('sensor.humidity', '48', { friendly_name: 'Living Room Humidity', unit_of_measurement: '%' })],
  ['sensor.power', entity('sensor.power', '320', { friendly_name: 'Whole-home Power', unit_of_measurement: 'W' })],
  ['climate.thermostat', entity('climate.thermostat', 'heat', { friendly_name: 'Thermostat', temperature: 21, current_temperature: 22.5, hvac_modes: ['off', 'heat', 'cool', 'auto'] })],
  ['media_player.tv', entity('media_player.tv', 'off', { friendly_name: 'TV' })],
  ['scene.cinema', entity('scene.cinema', 'off', { friendly_name: 'Cinema Mode' })],
  ['scene.goodnight', entity('scene.goodnight', 'off', { friendly_name: 'Goodnight Mode' })],
  ['scene.away', entity('scene.away', 'off', { friendly_name: 'Away Mode' })],
])

/** One-click scenes: scene id → entities to set when activated. */
const SCENES = {
  'scene.cinema': {
    'light.living_room': { state: 'on', attributes: { brightness: 40, color_temp: 180 } },
    'media_player.tv': { state: 'on' },
    'light.bedroom': { state: 'off' },
  },
  'scene.goodnight': {
    'light.living_room': { state: 'off' },
    'light.bedroom': { state: 'off' },
    'media_player.tv': { state: 'off' },
    'climate.thermostat': { state: 'cool', attributes: { temperature: 24 } },
  },
  'scene.away': {
    'light.living_room': { state: 'off' },
    'light.bedroom': { state: 'off' },
    'media_player.tv': { state: 'off' },
    'switch.boiler': { state: 'off' },
  },
}

/** Activate a scene: cascade the target states, broadcasting each change. */
function applyScene(sceneId) {
  const targets = SCENES[sceneId]
  if (!targets) return 0
  let matched = 0
  for (const [id, spec] of Object.entries(targets)) {
    const e = entities.get(id)
    if (!e) continue
    const old = { entity_id: e.entity_id, state: e.state, attributes: e.attributes, last_changed: e.last_changed }
    e.state = spec.state
    if (spec.attributes) Object.assign(e.attributes, spec.attributes)
    stamp(e)
    recordChange(e, old)
    matched += 1
  }
  return matched
}

for (const e of entities.values()) recordChange(e)

// Let the temperature drift so ha_history always has fresh data.
const driftInterval = setInterval(() => {
  const t = entities.get('sensor.temperature')
  const base = 21 + Math.random() * 3
  const old = { entity_id: t.entity_id, state: t.state }
  t.state = base.toFixed(1)
  stamp(t)
  t.attributes.current_temperature = t.state
  recordChange(t, old)
}, 5000)

// ---------------------------------------------------------------------------
// Tiny service registry — the interesting part: calls actually change state.
// ---------------------------------------------------------------------------

const services = {
  light: {
    turn_on(e, data) {
      e.state = 'on'
      if (typeof data.brightness === 'number') e.attributes.brightness = data.brightness
    },
    turn_off(e) { e.state = 'off' },
    toggle(e) { e.state = e.state === 'on' ? 'off' : 'on' },
  },
  switch: {
    turn_on(e) { e.state = 'on' },
    turn_off(e) { e.state = 'off' },
    toggle(e) { e.state = e.state === 'on' ? 'off' : 'on' },
  },
  media_player: {
    turn_on(e) { e.state = 'on' },
    turn_off(e) { e.state = 'off' },
  },
  climate: {
    set_temperature(e, data) {
      if (typeof data.temperature === 'number') {
        e.attributes.temperature = data.temperature
        e.attributes.current_temperature = data.temperature
      }
    },
    set_hvac_mode(e, data) {
      if (data.hvac_mode) e.state = data.hvac_mode
    },
  },
  homeassistant: {
    toggle(e) { e.state = e.state === 'on' ? 'off' : 'on' },
  },
  scene: {
    turn_on(e) { applyScene(e.entity_id) },
  },
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function authorized(req) {
  const auth = req.headers.authorization ?? ''
  return auth.startsWith('Bearer ')
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  const path = url.pathname

  // CORS for the interactive demo page (docs/demo.html) opened from any origin.
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    return res.end()
  }

  if (!authorized(req)) {
    return sendJson(res, 401, { message: 'Missing or invalid authorization. Expected "Bearer <token>".' })
  }

  // GET /api/ — health marker
  if (req.method === 'GET' && path === '/api/') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end('"API running."')
  }

  // GET /api/config
  if (req.method === 'GET' && path === '/api/config') {
    return sendJson(res, 200, {
      location_name: 'Demo Home',
      version: '2026.8.0-demo',
      time_zone: 'Asia/Shanghai',
      unit_system: { temperature: '°C', length: 'km', mass: 'kg', volume: 'L' },
    })
  }

  // GET /api/states
  if (req.method === 'GET' && path === '/api/states') {
    return sendJson(res, 200, [...entities.values()])
  }

  // GET /api/states/<entity_id>
  const stateMatch = path.match(/^\/api\/states\/(.+)$/)
  if (req.method === 'GET' && stateMatch) {
    const e = entities.get(decodeURIComponent(stateMatch[1]))
    if (!e) return sendJson(res, 404, { message: 'Entity not found' })
    return sendJson(res, 200, e)
  }

  // GET /api/history/period/<start>?filter_entity_id=...&end=...
  if (req.method === 'GET' && path.startsWith('/api/history/period/')) {
    const filter = url.searchParams.get('filter_entity_id')
    const end = url.searchParams.get('end')
    const rows = filter ? [filter] : [...history.keys()]
    const result = rows.map(id => {
      const log = (history.get(id) ?? [])
        .filter(h => !end || h.last_changed <= end)
        .slice(-50)
      return log
    })
    return sendJson(res, 200, result)
  }

  // POST /api/services/<domain>/<service>
  const serviceMatch = path.match(/^\/api\/services\/([^/]+)\/([^/]+)$/)
  if (req.method === 'POST' && serviceMatch) {
    const domain = decodeURIComponent(serviceMatch[1])
    const service = decodeURIComponent(serviceMatch[2])
    let data = {}
    req.on('data', chunk => {
      try { data = JSON.parse(String(chunk)) } catch { /* ignore malformed body */ }
    })
    req.on('end', () => {
      // Target resolution: entity_id(s) | area_id (all entities in the room) | device_id (demo: same as entity).
      let targets
      if (Array.isArray(data.entity_id)) targets = data.entity_id
      else if (typeof data.entity_id === 'string') targets = [data.entity_id]
      else if (typeof data.area_id === 'string') targets = AREA_ENTITIES[data.area_id] ?? []
      else if (typeof data.device_id === 'string') targets = DEVICE_ENTITIES[data.device_id] ?? []
      else targets = [...entities.keys()]
      const fn = services[domain]?.[service]
      if (!fn) {
        return sendJson(res, 404, { message: `Service ${domain}.${service} not found` })
      }
      let matched = 0
      for (const id of targets) {
        const e = entities.get(id)
        if (!e) continue
        const old = { entity_id: e.entity_id, state: e.state, attributes: e.attributes, last_changed: e.last_changed }
        fn(e, data)
        stamp(e)
        recordChange(e, old)
        matched += 1
      }
      if (matched === 0) {
        return sendJson(res, 404, { message: `One or more entities not found: ${targets.join(', ')}` })
      }
      sendJson(res, 200, {})
    })
    return
  }

  // POST /api/template — minimal Jinja: {{ states('x') }} and {{ is_state('x','on') }}
  if (req.method === 'POST' && path === '/api/template') {
    let body = {}
    req.on('data', chunk => {
      try { body = JSON.parse(String(chunk)) } catch { /* ignore */ }
    })
    req.on('end', () => {
      const template = String(body.template ?? '')
      // Support both ' and " quotes: {{ states("sensor.x") }}, {{ is_state('light.x','on') }}
      const rendered = template
        .replace(/\{\{\s*states\((['"])([^'"]+)\1\)\s*\}\}/g, (_m, _q, id) => {
          return entities.get(id)?.state ?? 'unknown'
        })
        .replace(/\{\{\s*is_state\((['"])([^'"]+)\1\s*,\s*(['"])([^'"]+)\3\)\s*\}\}/g, (_m, _q1, id, _q2, state) => {
          return String((entities.get(id)?.state ?? '') === state)
        })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(rendered))
    })
    return
  }

  sendJson(res, 404, { message: `No route for ${req.method} ${path}` })
})

server.listen(PORT, '127.0.0.1', () => {
  if (!process.stdout.isTTY) return // stay quiet when imported by tests
  console.log(`
┌──────────────────────────────────────────────────────────────┐
│  dsh-smarthome demo emulator                                 │
│                                                              │
│  REST  http://127.0.0.1:${String(PORT).padEnd(36)}│
│  WS    ws://127.0.0.1:${PORT}/api/websocket                    │
│                                                              │
│  Configure the plugin:                                       │
│    - id: smarthome                                           │
│      config:                                                 │
│        baseUrl: http://127.0.0.1:${PORT}                       │
│        tokenEnv: HOME_ASSISTANT_TOKEN                        │
│    HOME_ASSISTANT_TOKEN=demo-token dsh --profile web          │
│                                                              │
│  Then ask the agent:                                         │
│    "Check Home Assistant health and list the lights."        │
│    "Turn on the bedroom light."   (approval → state changes) │
│    "Turn off the lights in the living room." (area control)  │
│    "What changed in the last minute?"       (ha_events)      │
└──────────────────────────────────────────────────────────────┘`)
})

// ---------------------------------------------------------------------------
// WebSocket API (HA-compatible subset): auth, area registry, state_changed.
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server, path: '/api/websocket' })

wss.on('connection', (ws) => {
  let authed = false

  const send = (obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)) }
  send({ type: 'auth_required' })

  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(String(raw)) } catch { return }

    if (!authed) {
      if (msg.type === 'auth' && typeof msg.access_token === 'string' && msg.access_token.length > 0) {
        authed = true
        send({ type: 'auth_ok' })
      } else {
        send({ type: 'auth_invalid', message: 'Invalid access token' })
        ws.close()
      }
      return
    }

    if (msg.type === 'ping') return send({ type: 'pong' })

    if (msg.type === 'config/area_registry/list') {
      return send({ id: msg.id, type: 'result', success: true, result: AREAS })
    }

    if (msg.type === 'config/device_registry/list') {
      return send({ id: msg.id, type: 'result', success: true, result: DEVICE_REGISTRY })
    }

    if (msg.type === 'subscribe_events') {
      wsSubscribers.add(ws)
      return send({ id: msg.id, type: 'result', success: true, result: null })
    }

    if (msg.type === 'unsubscribe_events') {
      wsSubscribers.delete(ws)
      return send({ id: msg.id, type: 'result', success: true, result: null })
    }

    send({ id: msg.id, type: 'result', success: false, error: { code: 'not_supported', message: `Unknown command: ${msg.type}` } })
  })

  ws.on('close', () => wsSubscribers.delete(ws))
  ws.on('error', () => wsSubscribers.delete(ws))
})

/**
 * Shut the emulator down cleanly (used by tests that import this script
 * in-process instead of spawning it).
 */
export function stop() {
  clearInterval(driftInterval)
  wss.close()
  server.close()
}
