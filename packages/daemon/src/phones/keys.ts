import path from 'node:path'
import {
  type Edition,
  edition,
  fromBase64Url,
  relayChannel,
  relayUrl,
  tedEnv,
  toBase64Url,
} from '@ted/protocol'
import nacl from 'tweetnacl'
import { type Keyring, loadKeyring } from '../linear/keyring.ts'
import type { BoxKeys } from './crypto.ts'

export const phoneBoxKeyAccount = 'phone-relay-box-key'
export const phoneSignKeyAccount = 'phone-relay-sign-key'

export interface PhoneKeys {
  box: BoxKeys
  sign: { publicKey: Uint8Array; secretKey: Uint8Array }
  channel: string
}

type PhoneKeyring = Pick<Keyring, 'get' | 'set'>

export type PhoneKeyrings = (account: string) => Promise<PhoneKeyring>

const osPhoneKeyrings: PhoneKeyrings = (account) =>
  loadKeyring(process.env, process.platform, account)

export function phoneKeyringsForHome(
  home: string,
  relay = relayUrl(),
  env: NodeJS.ProcessEnv = process.env,
  which: Edition = edition,
): PhoneKeyrings {
  const taskHomeSuffix = path.join(path.sep, 'node_modules', '.cache', 'ted-home')
  if (
    which !== 'dev' ||
    tedEnv('TED_ELECTRON_HIDDEN', env, which) !== '1' ||
    !path.isAbsolute(home) ||
    !path.normalize(home).endsWith(taskHomeSuffix)
  ) {
    return osPhoneKeyrings
  }
  const url = URL.parse(relay)
  if (
    !url ||
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]')
  ) {
    return osPhoneKeyrings
  }

  const secrets = new Map<string, string>()
  return async (account) => ({
    async get() {
      return secrets.get(account)
    },
    async set(secret) {
      secrets.set(account, secret)
    },
  })
}

async function stored<T>(
  keyring: PhoneKeyring,
  restore: (secret: Uint8Array) => T | undefined,
  make: () => { pair: T; secret: Uint8Array },
): Promise<T> {
  const saved = await keyring.get()
  const secret = saved === undefined ? undefined : fromBase64Url(saved)
  const restored = secret && restore(secret)
  if (restored) return restored
  const made = make()
  await keyring.set(toBase64Url(made.secret))
  return made.pair
}

export async function loadPhoneKeys(keyrings: PhoneKeyrings): Promise<PhoneKeys> {
  const box = await stored(
    await keyrings(phoneBoxKeyAccount),
    (secret) =>
      secret.length === nacl.box.secretKeyLength
        ? nacl.box.keyPair.fromSecretKey(secret)
        : undefined,
    () => {
      const pair = nacl.box.keyPair()
      return { pair, secret: pair.secretKey }
    },
  )
  const sign = await stored(
    await keyrings(phoneSignKeyAccount),
    (seed) => (seed.length === nacl.sign.seedLength ? nacl.sign.keyPair.fromSeed(seed) : undefined),
    newSignKey,
  )
  return { box, sign, channel: relayChannel(sign.publicKey) }
}

function newSignKey() {
  const seed = nacl.randomBytes(nacl.sign.seedLength)
  return { pair: nacl.sign.keyPair.fromSeed(seed), secret: seed }
}

export async function replaceRelayKey(
  keyrings: PhoneKeyrings,
  keys: PhoneKeys,
): Promise<PhoneKeys> {
  const made = newSignKey()
  await (await keyrings(phoneSignKeyAccount)).set(toBase64Url(made.secret))
  return { box: keys.box, sign: made.pair, channel: relayChannel(made.pair.publicKey) }
}
