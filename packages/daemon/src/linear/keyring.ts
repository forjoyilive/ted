import { pathToFileURL } from 'node:url'
import { AsyncEntry } from '@napi-rs/keyring'
import { type Edition, edition, identity, tedEnv } from '@ted/protocol'

export type KeyringKind = 'macos-keychain' | 'secret-service'

export interface Keyring {
  readonly kind: KeyringKind
  get(): Promise<string | undefined>
  set(secret: string): Promise<void>
  delete(): Promise<void>
}

export class KeyringUnavailableError extends Error {
  readonly reason: 'no-keyring' | 'locked'
  constructor(reason: 'no-keyring' | 'locked', detail: string) {
    super(detail)
    this.reason = reason
  }
}

export const keyringService = identity().keyringService
export const linearKeyAccount = 'linear-api-key'

export function osKeyring(
  platform: NodeJS.Platform = process.platform,
  account = linearKeyAccount,
): Keyring {
  const kind: KeyringKind = platform === 'darwin' ? 'macos-keychain' : 'secret-service'
  const entry = () =>
    new AsyncEntry(keyringService, account, { linux: { store: 'secret-service' } })
  const unavailable = (error: unknown): Error => {
    const detail = error instanceof Error ? error.message : String(error)
    if (/\block(ed)?\b/i.test(detail)) return new KeyringUnavailableError('locked', detail)
    if (platform === 'linux') return new KeyringUnavailableError('no-keyring', detail)
    return new Error(`Couldn’t use the macOS Keychain: ${detail}`)
  }
  return {
    kind,
    async get() {
      try {
        return (await entry().getPassword()) ?? undefined
      } catch (error) {
        throw unavailable(error)
      }
    },
    async set(secret) {
      try {
        await entry().setPassword(secret)
      } catch (error) {
        throw unavailable(error)
      }
    },
    async delete() {
      try {
        await entry().deleteCredential()
      } catch (error) {
        throw unavailable(error)
      }
    },
  }
}

export async function loadKeyring(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  account = linearKeyAccount,
  which: Edition = edition,
): Promise<Keyring> {
  const module = tedEnv('TED_KEYRING_MODULE', env, which)
  if (!module) return osKeyring(platform, account)
  const loaded = (await import(pathToFileURL(module).href)) as {
    default: (account?: string) => Keyring
  }
  return loaded.default(account)
}
