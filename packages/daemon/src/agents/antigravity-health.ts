import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { antigravityPlanNotice, type Billing } from '@ted/protocol'
import { runCli } from '../health/cli.ts'
import type { AuthCheck } from './agent.ts'

export async function antigravityHealth(options: {
  binary: string
  env: NodeJS.ProcessEnv
  cwd: string
  billing: Billing
  planAccepted: boolean
}): Promise<AuthCheck> {
  const help = await runCli(options.binary, ['acp', '--help'], options)
  if (help.code !== 0)
    return {
      signedIn: false,
      problem: {
        reason:
          'Antigravity’s ACP check failed. Run agy acp --help in a terminal, repair the CLI, then choose Check again.',
      },
    }
  if (!/Agent Client Protocol/.test(help.stdout))
    return {
      signedIn: false,
      problem: {
        reason:
          'This Antigravity CLI does not advertise ACP support. Update it, then choose Check again.',
        fix: { label: 'Update', command: 'agy update' },
      },
    }
  if (options.billing === 'api-key') {
    return options.env.GEMINI_API_KEY
      ? { signedIn: true, billing: 'api-key', account: 'Gemini API key configured' }
      : {
          signedIn: false,
          problem: {
            reason:
              'Set GEMINI_API_KEY in your login-shell environment for Antigravity API-key billing, then choose Check again.',
          },
        }
  }
  if (!options.planAccepted) return { signedIn: false, problem: { reason: antigravityPlanNotice } }
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
