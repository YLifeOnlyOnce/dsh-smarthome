/**
 * Minimal, dependency-free Home Assistant REST API client.
 *
 * Only the v1 REST API is used: states, history, service calls, config, and
 * template rendering. Everything is plain JSON over fetch, so the plugin has
 * zero runtime dependencies beyond what the harness already provides.
 */

/** Lossless JSON value (Home Assistant API payloads are plain JSON). */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

export interface HaState {
  entity_id: string
  state: string
  attributes: Record<string, Json>
  last_changed: string
  last_updated: string
  context?: { id?: string; user_id?: string | null; parent_id?: string | null }
}

export interface HaConfig {
  location_name?: string
  version?: string
  time_zone?: string
  unit_system?: { length?: string; mass?: string; temperature?: string; volume?: string }
  [key: string]: unknown
}

export class HomeAssistantError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'HomeAssistantError'
    this.status = status
  }
}

export interface HistoryOptions {
  /** ISO start time; defaults to one hour ago. */
  start?: string
  /** Optional ISO end time. */
  end?: string
  /** Restrict to one entity. */
  entityId?: string
}

export class HomeAssistantClient {
  readonly baseUrl: string
  readonly token: string
  readonly timeoutMs: number

  constructor(baseUrl: string, token: string, timeoutMs = 15000) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.token = token
    this.timeoutMs = timeoutMs
  }

  /** True when a token is available; all requests fail loudly when false. */
  get configured(): boolean {
    return this.token.length > 0
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.configured) {
      throw new HomeAssistantError(
        'dsh-smarthome is not configured: no Home Assistant token. ' +
          'Set `token` or `tokenEnv` in the smarthome plugin config, then restart dsh.',
      )
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          ...init.headers,
        },
        signal: controller.signal,
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        const detail = body ? `: ${body.slice(0, 300)}` : ''
        throw new HomeAssistantError(
          `Home Assistant ${res.status} ${res.statusText}${detail}`,
          res.status,
        )
      }
      return (await res.json()) as T
    } catch (err) {
      if (err instanceof HomeAssistantError) throw err
      if (err instanceof Error && err.name === 'AbortError') {
        throw new HomeAssistantError(
          `Home Assistant request timed out after ${this.timeoutMs}ms: ${path}`,
        )
      }
      throw new HomeAssistantError(
        `Home Assistant request failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      clearTimeout(timer)
    }
  }

  /** `GET /api/` — returns "API running." when reachable. */
  health(): Promise<string> {
    return this.request<string>('/api/')
  }

  /** `GET /api/config` — instance name, version, timezone, unit system. */
  getConfig(): Promise<HaConfig> {
    return this.request<HaConfig>('/api/config')
  }

  /** `GET /api/states` — every entity state. */
  getStates(): Promise<HaState[]> {
    return this.request<HaState[]>('/api/states')
  }

  /** `GET /api/states/<entity_id>` — one entity state. */
  getState(entityId: string): Promise<HaState> {
    return this.request<HaState>(`/api/states/${encodeURIComponent(entityId)}`)
  }

  /**
   * `POST /api/services/<domain>/<service>`.
   * `target` (entity_id / area_id / device_id) and `data` merge into one body.
   */
  callService(
    domain: string,
    service: string,
    target?: Record<string, unknown>,
    data?: Record<string, unknown>,
  ): Promise<unknown> {
    return this.request(`/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`, {
      method: 'POST',
      body: JSON.stringify({ ...target, ...data }),
    })
  }

  /** `GET /api/history/period/<start>` — one array of state timelines per entity. */
  async getHistory(options: HistoryOptions = {}): Promise<HaState[][]> {
    const start = options.start ?? new Date(Date.now() - 3600_000).toISOString()
    const query = new URLSearchParams()
    if (options.end) query.set('end', options.end)
    if (options.entityId) query.set('filter_entity_id', options.entityId)
    query.set('minimal_response', '')
    const qs = query.toString()
    const path = `/api/history/period/${encodeURIComponent(start)}${qs ? `?${qs}` : ''}`
    return this.request<HaState[][]>(path)
  }

  /** `POST /api/template` — render a Jinja2 template server-side. */
  renderTemplate(template: string): Promise<string> {
    return this.request<string>('/api/template', {
      method: 'POST',
      body: JSON.stringify({ template }),
    })
  }
}
