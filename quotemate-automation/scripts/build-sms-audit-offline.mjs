/** Reproducible local/CI website build with inert provider credentials.
 * Environment files remain untouched. Public font downloads may still occur;
 * this is a build, not a provider or authenticated workflow test.
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const env = { ...process.env }
for (const key of Object.keys(env)) {
  if (/(?:KEY|TOKEN|SECRET|PASSWORD|DSN)$/.test(key)) env[key] = ''
}
for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) {
  const file = join(root, name)
  if (!existsSync(file)) continue
  for (const match of readFileSync(file, 'utf8').matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)) {
    // An existing empty child variable also prevents Next's dotenv loader
    // from restoring a real local credential or enabling a live workflow.
    env[match[1]] = ''
  }
}
Object.assign(env, {
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from('offline.clerk.accounts.dev$').toString('base64')}`,
  CLERK_SECRET_KEY: 'sk_test_offline_build_only',
  NEXT_PUBLIC_CLERK_SIGN_IN_URL: '/sign-in',
  NEXT_PUBLIC_CLERK_SIGN_UP_URL: '/sign-up',
  NEXT_PUBLIC_SUPABASE_URL: 'https://sms-build.invalid',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'offline-build-anon',
  SUPABASE_SERVICE_ROLE_KEY: 'offline-build-service',
  STRIPE_SECRET_KEY: 'sk_test_offline_build_only',
  TWILIO_ACCOUNT_SID: `AC${'0'.repeat(32)}`,
  TWILIO_AUTH_TOKEN: 'offline-build-only',
  APP_URL: 'https://quotemax.example',
  PUBLIC_WEB_ORIGIN: 'https://quotemax.example',
  NEXT_PUBLIC_APP_URL: 'https://quotemax.example',
  NEXT_TELEMETRY_DISABLED: '1',
  CLERK_TELEMETRY_DISABLED: '1',
  SENTRY_AUTH_TOKEN: '',
  SENTRY_DSN: '',
  NEXT_PUBLIC_SENTRY_DSN: '',
  LIVE_DB: '', LIVE_LLM: '', LIVE_REFINE: '',
})
const result = spawnSync(process.execPath, [require.resolve('next/dist/bin/next'), 'build'], {
  cwd: root, env, stdio: 'inherit',
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1
