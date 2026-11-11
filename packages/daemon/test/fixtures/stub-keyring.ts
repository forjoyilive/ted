import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tedHome } from '@ted/protocol'
import { type Keyring, KeyringUnavailableError } from '../../src/linear/keyring.ts'

export interface StubKeyringState {
  state?: 'ok' | 'no-keyring' | 'locked'
  kind?: Keyring['kind']
  secret?: string
}

export function stubKeyringFile(home: string): string {
  return path.join(home, 'stub-keyring.json')
}

export async function readStubKeyring(file: string): Promise<StubKeyringState> {
  return JSON.parse(await readFile(file, 'utf8').catch(() => '{}')) as StubKeyringState
}

export function stubKeyring(file: string): Keyring {
  const load = () => readStubKeyring(file)
  const save = async (state: StubKeyringState) => {
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 })
      await rename(temporary, file)
    } finally {
      await rm(temporary, { force: true })
    }
  }
  const usable = async () => {
    const state = await load()
    if (state.state === 'no-keyring') {
      throw new KeyringUnavailableError('no-keyring', 'org.freedesktop.secrets was not provided')
    }
    if (state.state === 'locked')
      throw new KeyringUnavailableError('locked', 'collection is locked')
    return state
  }
  return {
    kind: 'macos-keychain',
    async get() {
      return (await usable()).secret
    },
    async set(secret) {
      const state = await usable()
      await save({ ...state, secret })
    },
    async delete() {
      const { secret: _, ...state } = await usable()
      await save(state)
    },
  }
}

export default function createStubKeyring(): Keyring {
  return stubKeyring(process.env.TED_STUB_KEYRING ?? stubKeyringFile(tedHome()))
}
