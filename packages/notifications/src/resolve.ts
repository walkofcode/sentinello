// resolveSecret() lets an operator store `env:NAME` in notification_targets.config_json instead of
// the raw secret. At dispatch time the sender resolves `env:NAME` to `process.env.NAME`. See the
// README "Notifications & webhooks" section.

const ENV_PREFIX = 'env:'

export function resolveSecret(value: string): string {
    if (!value) return value
    if (!value.startsWith(ENV_PREFIX)) return value
    const envName = value.slice(ENV_PREFIX.length).trim()
    if (envName.length === 0) return value
    const envValue = process.env[envName]
    return envValue || ''
}
