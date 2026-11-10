import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { edition } from '@ted/protocol'

export const demoVersion = 1
export const demoMarker = 'demo.json'
export interface DemoManifest {
  kind?: 'ted-dev-demo'
  version: number
  complete: boolean
  tasks?: Record<string, string>
  elapsedMs?: number
}

export function demoHome(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.TED_HOME || path.join(homedir(), '.ted-dev-demo'))
}

export async function checkDemoHome(home: string): Promise<DemoManifest | undefined> {
  if (edition !== 'dev') throw new Error('Demo data is available only in TED Dev.')
  const resolved = path.resolve(home)
  const protectedHomes = ['.ted', '.ted-dev'].map((name) => path.join(homedir(), name))
  const localTrials = fileURLToPath(
    new URL('../../../../node_modules/.cache/ted-home', import.meta.url),
  )
  const inTrials = resolved === localTrials || resolved.startsWith(`${localTrials}${path.sep}`)
  if (
    [homedir(), path.parse(resolved).root, ...protectedHomes].some(
      (p) => resolved === p || p.startsWith(`${resolved}${path.sep}`),
    ) ||
    (!inTrials && protectedHomes.some((p) => resolved.startsWith(`${p}${path.sep}`)))
  ) {
    throw new Error('Choose a separate demo home, outside the TED and TED Dev homes.')
  }
  let current = path.parse(resolved).root
  for (const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    const stat = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return undefined
    })
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
      throw new Error('The demo home must contain only plain directory ancestors.')
  }
  const names = await readdir(resolved).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return []
  })
  if (names.length === 0) return undefined
  const marker = path.join(resolved, demoMarker)
  const stat = await lstat(marker).catch(() => undefined)
  if (!stat?.isFile() || stat.isSymbolicLink())
    throw new Error('Refusing an unrecognized nonempty demo home.')
  const manifest = JSON.parse(await readFile(marker, 'utf8')) as DemoManifest
  if (
    manifest.kind !== 'ted-dev-demo' ||
    !Number.isInteger(manifest.version) ||
    typeof manifest.complete !== 'boolean'
  )
    throw new Error('Invalid demo manifest.')
  for (const name of [
    'daemon.json',
    'daemon-lock.db',
    'run-token.key',
    'store',
    'repos',
    'worktrees',
    'runs',
    'apps',
    'plans',
    'secrets',
    'inputs',
    'origins',
    'fixture-repos',
    'logs',
    'gitconfig',
    'electron',
    'library',
  ]) {
    const entry = await lstat(path.join(resolved, name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return undefined
    })
    if (entry?.isSymbolicLink()) throw new Error(`The demo’s ${name} must not be a link.`)
  }
  if ((await realpath(resolved)) !== resolved) throw new Error('The demo home must not be a link.')
  return manifest
}

export async function markDemo(home: string, manifest: DemoManifest): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 })
  const temporary = path.join(home, `${demoMarker}.${randomUUID()}.tmp`)
  await writeFile(
    temporary,
    `${JSON.stringify({ ...manifest, kind: 'ted-dev-demo' }, null, 2)}\n`,
    {
      mode: 0o600,
      flag: 'wx',
    },
  )
  await rename(temporary, path.join(home, demoMarker))
}

export function demoEnvironment(
  home: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(base).filter(([key]) =>
      /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TMP|TEMP|LANG|LC_.*|TERM|DISPLAY|XAUTHORITY|XDG_RUNTIME_DIR|SYSTEMROOT|WINDIR)$/i.test(
        key,
      ),
    ),
  )
  const fixture = (name: string) =>
    fileURLToPath(new URL(`../../test/fixtures/${name}`, import.meta.url))
  return {
    ...env,
    ...(base.TED_TEST_RUN && { TED_TEST_RUN: base.TED_TEST_RUN }),
    ...(base.TED_TEST_FILE && { TED_TEST_FILE: base.TED_TEST_FILE }),
    ...(base.TED_EXIT_WITH_PID && { TED_EXIT_WITH_PID: base.TED_EXIT_WITH_PID }),
    ...(base.TED_HIDDEN_WINDOW && { TED_HIDDEN_WINDOW: base.TED_HIDDEN_WINDOW }),
    SHELL: fixture('stub-shell.sh'),
    TED_HOME: home,
    TED_DEMO: '1',
    TED_CLAUDE_BIN: fixture('stub-claude.ts'),
    TED_CODEX_BIN: fixture('stub-codex.ts'),
    TED_GH_BIN: fixture('stub-gh.ts'),
    TED_XCRUN_BIN: fixture('stub-xcrun.ts'),
    TED_OPEN_BIN: fixture('stub-xcrun.ts'),
    TED_STUB_XCRUN: path.join(home, 'xcrun.json'),
    TED_KEYRING_MODULE: fixture('stub-keyring.ts'),
    TED_LINEAR_API: 'http://127.0.0.1:9/graphql',
    TED_STUB_GH: path.join(home, 'gh.json'),
    TED_LOGIN_SHELL: 'off',
    TED_FREE_BYTES_FILE: fixture('free-bytes.txt'),
    TED_ONLINE_FILE: fixture('online.txt'),
    TED_STAY_AWAKE: 'off',
    TED_TIME_MACHINE: 'off',
    TED_SKIP_FIRST_LAUNCH: '1',
    TED_NOTIFY_LOG: path.join(home, 'notifications.jsonl'),
    TED_NOTIFY_STATUS: 'off',
    TED_FIX_LOG: path.join(home, 'fix.log'),
    TED_NUDGE_AFTER_MS: String(7 * 24 * 60 * 60_000),
    TED_STALL_AFTER_MS: String(7 * 24 * 60 * 60_000),
    GIT_ALLOW_PROTOCOL: 'file',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig'),
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: `url.file://${path.join(home, 'origins')}/.insteadOf`,
    GIT_CONFIG_VALUE_0: 'https://github.com/demo/',
    GIT_CONFIG_KEY_1: 'protocol.file.allow',
    GIT_CONFIG_VALUE_1: 'always',
  }
}
