import { fromBase64Url, relayChannel, toBase64Url } from '@ted/protocol'
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

export type PhoneKeyrings = (account: string) => Promise<Keyring>

export const osPhoneKeyrings: PhoneKeyrings = (account) =>
  loadKeyring(process.env, process.platform, account)

async function stored<T>(
  keyring: Keyring,
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
    () => {
      const seed = nacl.randomBytes(nacl.sign.seedLength)
      return { pair: nacl.sign.keyPair.fromSeed(seed), secret: seed }
    },
  )
  return { box, sign, channel: relayChannel(sign.publicKey) }
}
