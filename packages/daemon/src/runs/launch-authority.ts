import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { TedStore } from '../store/index.ts'

export interface LaunchAuthority {
  file: string
  value: string
}

const authorities = new WeakMap<TedStore, LaunchAuthority>()

export async function initializeLaunchAuthority(store: TedStore, home: string): Promise<void> {
  const authority = { file: path.join(home, 'launch-authority'), value: randomUUID() }
  await writeFile(authority.file, authority.value, { mode: 0o600 })
  authorities.set(store, authority)
}

export function launchAuthority(store: TedStore): LaunchAuthority {
  const authority = authorities.get(store)
  if (!authority) throw new Error('The daemon has not initialized process launch authority')
  return authority
}

export function checkLaunchAuthority(authority: LaunchAuthority | undefined): void {
  if (!authority || readFileSync(authority.file, 'utf8') !== authority.value)
    throw new Error('This launch belongs to an earlier daemon; TED must prepare it again')
}
