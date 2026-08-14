import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { credentialRef, type CredentialRef, type ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { Config as ConfigSchema, type Config } from './config'
import { HomeAssistantClient, HomeAssistantWsClient } from './ha'
import { registerTools } from './tools'

export const name = 'dsh-smarthome'
export const inject = ['tools']

export { ConfigSchema as Config }

/** Tools that change (or can be abused to change) Home Assistant state. */
const SENSITIVE_TOOLS = new Set(['ha_call_service', 'ha_render_template'])

/** Structural view of the optional credentials seam (see @deepseek-ai/dsh-credentials). */
interface CredentialsService {
  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>
}

export function apply(ctx: Context, config: Config) {
  // Token resolution through the harness credential seam when present, with
  // the process environment as the fallback plane (same layering as the
  // official LLM adapters). `tokenEnv` is the credential reference: a POSIX
  // environment-variable name resolved per request / per socket connection,
  // so a rotated credential reaches the very next call.
  const credentials = ctx.get('credentials') as CredentialsService | undefined
  const resolveToken = async (): Promise<string> => {
    if (config.token) return config.token
    const ref = credentialRef(config.tokenEnv)
    if (credentials) {
      const hit = await credentials.resolve(ref)
      if (hit) return hit.value
    }
    return process.env[config.tokenEnv] ?? ''
  }

  const client = new HomeAssistantClient(config.baseUrl, '', config.timeoutMs, resolveToken)

  // Real-time WebSocket client (state_changed events + area registry). The
  // effect ties its lifetime to this plugin fiber: `start()` on load,
  // `dispose()` on unload / HMR.
  const ws = new HomeAssistantWsClient(config.baseUrl, '', {
    enabled: config.wsEnabled,
    bufferSize: config.eventBufferSize,
  }, resolveToken)
  ctx.effect(() => {
    void ws.start()
    return () => ws.dispose()
  }, `${name}.ws`)

  registerTools(ctx, client, ws, config)

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
