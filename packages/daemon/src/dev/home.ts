import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { edition, tedEnv } from '@ted/protocol'

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
  return path.resolve(tedEnv('TED_HOME', env) || path.join(homedir(), '.ted-dev-demo'))
}

async function canonicalPath(file: string): Promise<string> {
  try {
    return await realpath(file)
  } catch (error) {
    const parent = path.dirname(file)
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === file) throw error
    return path.join(await canonicalPath(parent), path.basename(file))
  }
}

const electronSingletonLinks = new Set(
  ['SingletonCookie', 'SingletonLock', 'SingletonSocket'].map((name) =>
    path.join('electron', name),
  ),
)

async function checkDemoLinks(home: string, directory = home): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return []
    },
  )
  for (const entry of entries) {
    const file = path.join(directory, entry.name)
    const relative = path.relative(home, file)
    if (entry.isSymbolicLink() && !electronSingletonLinks.has(relative))
      throw new Error(`The demo’s ${relative} must not be a link.`)
    if (entry.isDirectory()) await checkDemoLinks(home, file)
  }
}

const scratchFolders = ['worktrees', 'runs', 'sandbox']

export async function checkTrialHome(home: string): Promise<string> {
  if (edition !== 'dev') throw new Error('Local Factories can be added only in Ted Dev.')
  const resolved = path.resolve(home)
  const comparable = async (p: string) => (await canonicalPath(p)).toLowerCase()
  const protectedHomes = ['.ted', '.ted-dev'].map((name) => path.join(homedir(), name))
  const [candidate, userHome, protectedPaths] = await Promise.all([
    comparable(resolved),
    comparable(homedir()),
    Promise.all(protectedHomes.map(comparable)),
  ])
  const within = (parent: string) => candidate.startsWith(`${parent}${path.sep}`)
  const containsProtected = [userHome, path.parse(candidate).root, ...protectedPaths].some(
    (p) => candidate === p || p.startsWith(`${candidate}${path.sep}`),
  )
  const insideProtected = protectedPaths.some(
    (p) => within(p) && !scratchFolders.some((folder) => within(path.join(p, folder))),
  )
  if (containsProtected || insideProtected)
    throw new Error(
      'Choose a separate TED_HOME, such as node_modules/.cache/ted-home in your worktree, not the Ted or Ted Dev home.',
    )
  return resolved
}

export async function checkDemoHome(home: string): Promise<DemoManifest | undefined> {
  if (edition !== 'dev') throw new Error('Demo data is available only in Ted Dev.')
  const resolved = path.resolve(home)
  const protectedHomes = ['.ted', '.ted-dev'].map((name) => path.join(homedir(), name))
  const localTrials = fileURLToPath(
    new URL('../../../../node_modules/.cache/ted-home', import.meta.url),
  )
  const comparable = async (p: string) => (await canonicalPath(p)).toLowerCase()
  const [canonical, userHome, trials, protectedPaths] = await Promise.all([
    canonicalPath(resolved),
    comparable(homedir()),
    canonicalPath(localTrials),
    Promise.all(protectedHomes.map(comparable)),
  ])
  const candidate = canonical.toLowerCase()
  const inTrials = canonical === trials || canonical.startsWith(`${trials}${path.sep}`)
  if (
    [userHome, path.parse(candidate).root, ...protectedPaths].some(
      (p) => candidate === p || p.startsWith(`${candidate}${path.sep}`),
    ) ||
    (!inTrials && protectedPaths.some((p) => candidate.startsWith(`${p}${path.sep}`)))
  ) {
    throw new Error('Choose a separate demo home, outside the Ted and Ted Dev homes.')
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
  await checkDemoLinks(resolved)
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
    ...(tedEnv('TED_TEST_RUN', base) && { TED_TEST_RUN: tedEnv('TED_TEST_RUN', base) }),
    ...(tedEnv('TED_TEST_FILE', base) && { TED_TEST_FILE: tedEnv('TED_TEST_FILE', base) }),
    ...(tedEnv('TED_EXIT_WITH_PID', base) && {
      TED_EXIT_WITH_PID: tedEnv('TED_EXIT_WITH_PID', base),
    }),
    ...(tedEnv('TED_HIDDEN_WINDOW', base) && {
      TED_HIDDEN_WINDOW: tedEnv('TED_HIDDEN_WINDOW', base),
    }),
    SHELL: fixture('stub-shell.sh'),
    TED_HOME: home,
    TED_DEMO: '1',
    TED_CLAUDE_BIN: path.resolve(home, 'bin', 'stub-claude.mjs'),
    TED_CODEX_BIN: path.resolve(home, 'bin', 'stub-codex.mjs'),
    TED_GH_BIN: path.resolve(home, 'bin', 'stub-gh.mjs'),
    TED_XCRUN_BIN: fixture('stub-xcrun.ts'),
    TED_OPEN_BIN: fixture('stub-xcrun.ts'),
    TED_IDB_BIN: fixture('stub-idb.ts'),
    TED_STUB_XCRUN: path.join(home, 'xcrun.json'),
    TED_KEYRING_MODULE: fixture('stub-keyring.ts'),
    TED_LINEAR_API: 'http://127.0.0.1:9/graphql',
    TED_STUB_GH: path.join(home, 'gh.json'),
    TED_LOGIN_SHELL: 'off',
    TED_FREE_BYTES_FILE: fixture('free-bytes.txt'),
    TED_ONLINE_FILE: fixture('online.txt'),
    TED_LOAD_FILE: fixture('load.txt'),
    TED_MEMORY_FILE: fixture('memory.json'),
    TED_LOW_PRIORITY: 'off',
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

export async function withDemoEnvironment<T>(home: string, work: () => Promise<T>): Promise<T> {
  const original = { ...process.env }
  const prepared = demoEnvironment(home, original)
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, prepared)
  try {
    return await work()
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, original)
  }
}
