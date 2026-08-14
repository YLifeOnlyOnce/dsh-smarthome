import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { Config, type Config as ConfigType } from './config'
import { HomeAssistantClient } from './ha'
import { registerTools } from './tools'

export const name = 'dsh-smarthome'
export const inject = ['tools']

export { Config }

/** Tools that change (or can be abused to change) Home Assistant state. */
const SENSITIVE_TOOLS = new Set(['ha_call_service', 'ha_render_template'])

export function apply(ctx: Context, config: ConfigType) {
  // Token resolution: explicit `token` wins, otherwise read `tokenEnv`.
  // An empty token still loads the plugin — every call then fails with a
  // clear "not configured" message instead of crashing the harness at boot.
  const token = config.token || (config.tokenEnv ? process.env[config.tokenEnv] ?? '' : '')
  const client = new HomeAssistantClient(config.baseUrl, token, config.timeoutMs)

  registerTools(ctx, client, config)

  // Approval + allowlist policy on the tools/pre-execute waterfall.
  // `ask` pauses the call until a human approves through the approval seam.
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (!exec.name.startsWith('ha_')) return next()

    // Deny service calls on domains outside the configured allowlist.
    if (exec.name === 'ha_call_service' && config.allowedDomains.length > 0) {
      const args = exec.arguments as { domain?: unknown } | undefined
      const domain = typeof args?.domain === 'string' ? args.domain : undefined
      if (domain && !config.allowedDomains.includes(domain)) {
        return {
          kind: 'deny',
          reason: `dsh-smarthome: service domain "${domain}" is not in allowedDomains (${config.allowedDomains.join(', ')}).`,
        }
      }
    }

    // Require human approval for state-changing calls unless disabled.
    if (config.requireApproval && SENSITIVE_TOOLS.has(exec.name)) {
      return {
        kind: 'ask',
        reason: `dsh-smarthome: "${exec.name}" changes Home Assistant state — approve to continue.`,
      }
    }

    return next()
  })
}
