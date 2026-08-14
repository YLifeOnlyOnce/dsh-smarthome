import Schema from '@deepseek-ai/schemastery'

export interface Config {
  /** Home Assistant base URL, e.g. `http://homeassistant.local:8123`. */
  baseUrl: string
  /** Long-lived access token (HA → Profile → Security → Long-lived access tokens). */
  token: string
  /** Alternative to `token`: environment variable holding the token. */
  tokenEnv: string
  /** Request timeout in milliseconds. */
  timeoutMs: number
  /** Require human approval before state-changing calls (service calls, template rendering). */
  requireApproval: boolean
  /** Allowlist of service domains (e.g. `light`, `switch`, `climate`). Empty = any domain allowed. */
  allowedDomains: string[]
  /** Maximum history events returned by `ha_history`. */
  maxHistoryEvents: number
}

export const Config: Schema<Config> = Schema.object({
  baseUrl: Schema.string()
    .description('Home Assistant base URL, e.g. http://homeassistant.local:8123')
    .default('http://homeassistant.local:8123'),
  token: Schema.string()
    .description('Long-lived access token (HA → Profile → Security → Long-lived access tokens)')
    .default(''),
  tokenEnv: Schema.string()
    .description('Environment variable holding the token (used when `token` is empty)')
    .default('HOME_ASSISTANT_TOKEN'),
  timeoutMs: Schema.number()
    .description('Request timeout in milliseconds')
    .default(15000),
  requireApproval: Schema.boolean()
    .description('Require human approval before state-changing calls')
    .default(true),
  allowedDomains: Schema.array(Schema.string())
    .description('Allowed service domains (light, switch, …); empty allows every domain')
    .default([]),
  maxHistoryEvents: Schema.number()
    .description('Maximum history events returned by ha_history')
    .default(200),
})
