import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { waitUntil } from '../../../daemon/test/helpers.ts'

export async function executionStartupGate(parent: string) {
  const folder = path.join(await realpath(parent), 'worker-start-gate')
  await mkdir(folder, { mode: 0o700 })
  const shell = path.join(folder, 'shell')
  const quoted = `'${folder.replaceAll("'", "'\\''")}'`
  await writeFile(
    shell,
    `#!/bin/sh
if [ "$#" -ne 4 ] || [ "$1" != "-l" ] || [ "$2" != "-i" ] || [ "$3" != "-c" ]; then
  exec /bin/sh "$@"
fi
gate=${quoted}
if [ -z "$TED_HOME" ] && [ -f "$gate/hold" ]; then
  printf '%s\\n' "$PPID" > "$gate/started"
  while [ ! -f "$gate/release" ]; do /bin/sleep 0.05; done
fi
printf '%s' '__TED_LOGIN_ENV__'
/usr/bin/env -0
`,
    { mode: 0o700 },
  )
  return {
    env: { SHELL: shell, TED_LOGIN_SHELL: 'on' },
    hold: () => writeFile(path.join(folder, 'hold'), ''),
    release: () => writeFile(path.join(folder, 'release'), ''),
    pid: () =>
      waitUntil(async () => {
        const text = await readFile(path.join(folder, 'started'), 'utf8').catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error
            return ''
          },
        )
        const pid = Number(text.trim())
        return Number.isInteger(pid) && pid > 1 ? pid : undefined
      }, 'worker to enter its delayed login shell'),
  }
}
