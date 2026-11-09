import { execFile } from 'node:child_process'
import { userInfo } from 'node:os'
import { promisify } from 'node:util'
import type { Profile } from '@ted/protocol'

const execFileAsync = promisify(execFile)

export async function readProfile(): Promise<Profile> {
  const name = await execFileAsync('git', ['config', '--global', '--get', 'user.name'], {
    timeout: 5_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).then(
    ({ stdout }) => stdout.trim(),
    () => '',
  )
  return { name: name !== '' ? name : userInfo().username }
}
