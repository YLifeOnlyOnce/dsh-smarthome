import { createServer, type Server } from 'node:http'

/**
 * Minimal in-memory mock of the Home Assistant REST API used by the plugin.
 * Returns fixture data for the handful of endpoints the client touches.
 */
export interface MockHaOptions {
  /** Respond 401 to every request (bad token). */
  unauthorized?: boolean
  /** Delay every response by this many ms (timeout tests). */
  latencyMs?: number
  /** Track the JSON bodies of POST /api/services calls. */
  serviceCalls?: Array<{ domain: string; service: string; body: unknown }>
  /** Track rendered templates. */
  templates?: string[]
}

export function startMockHa(options: MockHaOptions = {}): Promise<{ server: Server; port: number }> {
  const calls = options.serviceCalls ?? []
  const templates = options.templates ?? []

  const server = createServer((req, res) => {
    const respond = (status: number, body: unknown) => {
      const respondNow = () => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      if (options.latencyMs) setTimeout(respondNow, options.latencyMs)
      else respondNow()
    }
    const respondRaw = (status: number, text: string) => {
      const respondNow = () => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(text)
      }
      if (options.latencyMs) setTimeout(respondNow, options.latencyMs)
      else respondNow()
    }

    if (options.unauthorized) {
      return respond(401, { message: 'Invalid token' })
    }

    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname

    if (req.method === 'GET' && path === '/api/') return respondRaw(200, '"API running."')
    if (req.method === 'GET' && path === '/api/config') {
      return respond(200, {
        location_name: 'Test Home',
        version: '2026.8.0',
        time_zone: 'Asia/Shanghai',
        unit_system: { temperature: '°C' },
      })
    }
    if (req.method === 'GET' && path === '/api/states') {
      return respond(200, [
        {
          entity_id: 'light.living_room',
          state: 'on',
          attributes: { friendly_name: 'Living Room Light', brightness: 128 },
          last_changed: '2026-08-14T10:00:00+08:00',
          last_updated: '2026-08-14T10:00:00+08:00',
        },
        {
          entity_id: 'sensor.temperature',
          state: '22.5',
          attributes: { friendly_name: 'Temperature', unit_of_measurement: '°C' },
          last_changed: '2026-08-14T10:05:00+08:00',
          last_updated: '2026-08-14T10:05:00+08:00',
        },
        {
          entity_id: 'switch.boiler',
          state: 'off',
          attributes: { friendly_name: 'Boiler' },
          last_changed: '2026-08-14T09:00:00+08:00',
          last_updated: '2026-08-14T09:00:00+08:00',
        },
      ])
    }
    if (req.method === 'GET' && path === '/api/states/light.living_room') {
      return respond(200, {
        entity_id: 'light.living_room',
        state: 'on',
        attributes: { friendly_name: 'Living Room Light', brightness: 128, rgb_color: [255, 180, 40] },
        last_changed: '2026-08-14T10:00:00+08:00',
        last_updated: '2026-08-14T10:00:00+08:00',
      })
    }
    if (path.startsWith('/api/history/period/')) {
      return respond(200, [
        [
          {
            entity_id: 'light.living_room',
            state: 'off',
            last_changed: '2026-08-14T09:00:00+08:00',
          },
          {
            entity_id: 'light.living_room',
            state: 'on',
            last_changed: '2026-08-14T10:00:00+08:00',
          },
        ],
      ])
    }
    if (req.method === 'POST' && path.startsWith('/api/services/')) {
      const parts = path.split('/') // ['', 'api', 'services', <domain>, <service>]
      const domain = parts[3]
      const service = parts[4]
      let body: unknown = null
      req.on('data', chunk => { body = JSON.parse(String(chunk)) })
      req.on('end', () => {
        calls.push({ domain: domain!, service: service!, body })
        respondRaw(200, '{}')
      })
      return
    }
    if (req.method === 'POST' && path === '/api/template') {
      let body: unknown = null
      req.on('data', chunk => { body = JSON.parse(String(chunk)) })
      req.on('end', () => {
        const template = (body as { template?: string })?.template ?? ''
        templates.push(template)
        respondRaw(200, JSON.stringify(`rendered: ${template}`))
      })
      return
    }

    respond(404, { message: `no mock route for ${req.method} ${path}` })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address && typeof address === 'object') {
        resolve({ server, port: address.port })
      } else {
        reject(new Error('mock server did not bind'))
      }
    })
  })
}
