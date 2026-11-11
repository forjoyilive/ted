import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { Billing } from '@ted/protocol'
import { runCli } from '../health/cli.ts'
import type { AuthCheck } from './agent.ts'

export async function antigravityHealth(options: {
  binary: string
  env: NodeJS.ProcessEnv
  cwd: string
  billing: Billing
}): Promise<AuthCheck> {
  const help = await runCli(options.binary, ['acp', '--help'], options)
  if (help.code !== 0 || !/Agent Client Protocol/.test(help.stdout)) return { signedIn: false }
  if (options.billing === 'api-key') {
    return options.env.GEMINI_API_KEY
      ? { signedIn: true, billing: 'api-key', account: 'Gemini API key configured' }
      : { signedIn: false }
  }
  // ACP has no silent auth-status request; session/new creates a saved conversation.
  // CLI 1.5.6 keeps only the selected method in this marker, never a credential.
  const home = options.env.HOME || options.env.USERPROFILE || homedir()
  try {
    const marker: unknown = JSON.parse(
      await readFile(
        path.join(home, '.gemini', 'antigravity-cli', 'cache', 'acp-auth-state.json'),
        'utf8',
      ),
    )
    return typeof marker === 'object' &&
      marker !== null &&
      'methodId' in marker &&
      marker.methodId === 'oauth-personal'
      ? { signedIn: true, billing: 'subscription', account: 'Google sign-in configured' }
      : { signedIn: false }
  } catch {
    return { signedIn: false }
  }
}
