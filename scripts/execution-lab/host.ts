import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, realpath, rm, statfs, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { hostname, userInfo } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

export interface ContentFile {
  name: string
  sha256: string
  mode: number
  content: string
}
export interface HostSpec {
  root: string
  home: string
  machineId: string
  node: string
  pnpm: string
}
export interface HostRequest {
  labId: string
  host: HostSpec
  action:
    | 'preflight'
    | 'identity'
    | 'deploy'
    | 'build'
    | 'probe'
    | 'start'
    | 'observe'
    | 'stop'
    | 'restart'
    | 'cleanup'
    | 'verify'
    | 'scenario'
    | 'product'
    | 'connect'
    | 'disconnect'
  runId: string
  timeoutMs?: number
  files?: ContentFile[]
  candidate?: { revision: string; contentHash: string; dirtyPatchIdentity: string | null }
  product?: {
    operation: string
    pair?: { details: string; capacity: number }
    operationId?: string
  }
  scenarios?: string[]
}

export const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
export const manifestDigest = (files: Pick<ContentFile, 'name' | 'sha256' | 'mode'>[]) =>
  digest(JSON.stringify(files.map(({ name, sha256, mode }) => ({ name, sha256, mode }))))

export function contentName(name: string) {
  if (
    !name ||
    path.posix.normalize(name) !== name ||
    name.startsWith('/') ||
    name
      .split('/')
      .some(
        (part) =>
          part === '..' ||
          part === '.git' ||
          part === 'node_modules' ||
          /^\.env(?:\.|$)/.test(part) ||
          /^(?:id_rsa|id_ed25519|credentials|secrets)$/i.test(part),
      ) ||
    [...name].some((character) => character.charCodeAt(0) < 32 || character === '\\')
  )
    throw new Error(`unsafe content path: ${name}`)
  return name
}

async function plain(target: string, directory = true) {
  if (!path.isAbsolute(target) || path.resolve(target) !== target || target === '/')
    throw new Error('expected absolute plain path')
  let cursor = '/'
  const parts = target.slice(1).split('/')
  for (let index = 0; index < parts.length; index++) {
    cursor = path.join(cursor, parts[index] ?? '')
    const entry = await lstat(cursor).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return undefined
    })
    if (
      entry?.isSymbolicLink() ||
      (entry && (index < parts.length - 1 || directory) && !entry.isDirectory())
    )
      throw new Error(`not a plain path: ${cursor}`)
  }
}

export async function command(
  program: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeout = 30_000,
) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(program, args, {
      env,
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    let stdout = ''
    let stderr = ''
    let expired = false
    const bounded = (previous: string, chunk: Buffer) =>
      (previous + chunk.toString()).slice(-128 * 1024)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = bounded(stdout, chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = bounded(stderr, chunk)
    })
    const kill = (signal: NodeJS.Signals) => {
      if (child.pid)
        try {
          process.kill(-child.pid, signal)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
    }
    const timer = setTimeout(() => {
      expired = true
      kill('SIGTERM')
    }, timeout)
    const force = setTimeout(() => kill('SIGKILL'), timeout + 2_000)
    child.on('error', (error) => {
      clearTimeout(timer)
      clearTimeout(force)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      clearTimeout(force)
      if (expired) kill('SIGKILL')
      resolve({ code: expired ? 124 : (code ?? 1), stdout, stderr })
    })
  })
}

async function must(
  program: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeout?: number,
) {
  const result = await command(program, args, env, cwd, timeout)
  if (result.code !== 0)
    throw new Error(
      `${path.basename(program)} ${args[0] ?? ''} failed (${result.code}): ${result.stderr || result.stdout}`,
    )
  return result.stdout.trim()
}

async function missing(file: string) {
  return lstat(file).then(
    () => false,
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return true
    },
  )
}

async function exchange(port: number) {
  return new Promise<{ pid: number; token: string }>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let text = ''
    socket.setTimeout(5000, () => socket.destroy(new Error('owned relay did not answer')))
    socket.on('data', (chunk: Buffer) => {
      text += chunk.toString()
      if (text.length > 4096) socket.destroy(new Error('owned relay response exceeds bound'))
    })
    socket.on('error', reject)
    socket.on('end', () => {
      try {
        resolve(JSON.parse(text) as { pid: number; token: string })
      } catch {
        reject(new Error('invalid owned relay response'))
      }
    })
  })
}

export async function hostIdentity() {
  if (process.platform !== 'darwin') throw new Error('lab requires actual Macs')
  const output = await must(
    '/usr/sbin/ioreg',
    ['-rd1', '-c', 'IOPlatformExpertDevice'],
    { PATH: '/usr/bin:/bin' },
    '/',
  )
  const machineId = /"IOPlatformUUID"\s*=\s*"([A-F0-9-]+)"/.exec(output)?.[1]
  if (!machineId) throw new Error('Mac platform UUID unavailable')
  return {
    machineId,
    hostname: hostname(),
    username: userInfo().username,
    uid: process.getuid?.(),
    arch: process.arch,
    node: process.version,
    home: userInfo().homedir,
  }
}

export function serviceEnvironment(host: HostSpec, run: string, source: string): NodeJS.ProcessEnv {
  const fixture = (name: string) => path.join(source, 'packages/daemon/test/fixtures', name)
  return {
    HOME: path.join(run, 'account'),
    PATH: `${path.dirname(host.node)}:${path.dirname(host.pnpm)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    SHELL: '/bin/sh',
    TMPDIR: path.join(run, 'tmp'),
    CI: '1',
    npm_config_cache: path.join(run, 'cache/npm'),
    npm_config_userconfig: '/dev/null',
    npm_config_globalconfig: path.join(run, 'account/global.npmrc'),
    XDG_CACHE_HOME: path.join(run, 'cache'),
    XDG_CONFIG_HOME: path.join(run, 'account/.config'),
    COREPACK_HOME: path.join(run, 'cache/corepack'),
    PNPM_HOME: path.join(run, 'cache/pnpm'),
    ELECTRON_CACHE: path.join(run, 'cache/electron'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Ted Lab',
    GIT_AUTHOR_EMAIL: 'ted-lab@example.invalid',
    GIT_COMMITTER_NAME: 'Ted Lab',
    GIT_COMMITTER_EMAIL: 'ted-lab@example.invalid',
    TED_HOME: path.join(run, 'ted-home'),
    TED_CLAUDE_BIN: fixture('stub-claude.ts'),
    TED_CODEX_BIN: fixture('stub-codex.ts'),
    TED_GH_BIN: fixture('stub-gh.ts'),
    TED_XCRUN_BIN: fixture('stub-xcrun.ts'),
    TED_OPEN_BIN: fixture('stub-xcrun.ts'),
    TED_LOGIN_SHELL: 'off',
    TED_KEYRING_MODULE: fixture('stub-keyring.ts'),
    TED_LINEAR_API: 'http://127.0.0.1:9/graphql',
    TED_STUB_GH: path.join(run, 'gh.json'),
    TED_STUB_GH_LOG: path.join(run, 'gh.jsonl'),
    TED_FREE_BYTES_FILE: fixture('free-bytes.txt'),
    TED_LOAD_FILE: fixture('load.txt'),
    TED_ONLINE_FILE: fixture('online.txt'),
    TED_STAY_AWAKE: 'off',
    TED_LOW_PRIORITY: 'off',
    TED_SKIP_FIRST_LAUNCH: '1',
    TED_TIME_MACHINE: 'off',
    TED_HIDDEN_WINDOW: '1',
    TED_APP_TOKEN: `lab-${path.basename(run)}`,
    TED_EDITOR_APP_DIRS: '',
    TED_SANDBOX_BIN: '/usr/bin/sandbox-exec',
    TED_LAB_RUN: path.basename(run),
    TED_REMOTE_EXECUTION: 'on',
  }
}

interface ProcessReceipt {
  pid: number
  identity: string
  token: string
}

export async function waitForProcessExit(
  pid: number,
  attempts: number,
  inspect: (pid: number) => Promise<string>,
  pause: () => Promise<unknown> = () => delay(100),
) {
  for (let tries = 0; tries < attempts; tries++) {
    if (!(await inspect(pid))) return true
    await pause()
  }
  return !(await inspect(pid))
}

export function markedListing(text: string, uid: number, runId: string, home: string) {
  const marker = (name: string, value: string) =>
    new RegExp(`(?:^|\\s)${name}=${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`).test(
      text,
    )
  const root = path.dirname(home)
  const entry = (file: string) =>
    new RegExp(`(?:^|\\s)${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`).test(text)
  const ordinary = marker('TED_HOME', home)
  const productWorker =
    marker('TED_EXECUTION_HOME', path.join(root, 'execution-worker')) &&
    entry(path.join(root, 'source/packages/daemon/src/execution/main.ts'))
  const productController =
    marker('TED_HOME', path.join(root, 'ted-execution-pairing/home')) &&
    entry(path.join(root, 'source/packages/daemon/test/fixtures/execution-machine.ts'))
  return (
    text.startsWith(`${uid} `) &&
    marker('TED_LAB_RUN', runId) &&
    (ordinary || productWorker || productController)
  )
}

async function markedProcesses(uid: number, runId: string, home: string, env: NodeJS.ProcessEnv) {
  const listing = await must('/bin/ps', ['-u', String(uid), '-o', 'pid='], env, '/')
  if (listing.length >= 128 * 1024) throw new Error('process list exceeds inspection bound')
  const found: { pid: number; identity: string }[] = []
  for (const value of listing.split(/\s+/)) {
    if (!/^\d+$/.test(value)) continue
    const pid = Number(value)
    const result = await command(
      '/bin/ps',
      ['eww', '-p', value, '-o', 'uid=,lstart=,command='],
      env,
      '/',
    )
    if (result.code !== 0) continue
    if (result.stdout.length >= 128 * 1024)
      throw new Error('process detail exceeds inspection bound')
    const identity = result.stdout.trim()
    if (markedListing(identity, uid, runId, home)) found.push({ pid, identity })
  }
  return found
}

async function processIdentity(pid: number, env: NodeJS.ProcessEnv) {
  const result = await command(
    '/bin/ps',
    ['-p', String(pid), '-o', 'stat=,uid=,lstart=,command='],
    env,
    '/',
  )
  if (result.code !== 0) return ''
  const match = /^(\S+)\s+(.+)$/.exec(result.stdout.trim())
  if (!match || match[1]?.startsWith('Z')) return ''
  return match[2]?.trim() ?? ''
}

export async function dispatch(request: HostRequest, identify = hostIdentity) {
  const { host, labId, runId, action } = request
  if (!/^[a-z0-9-]{8,64}$/.test(labId) || !/^[a-f0-9-]{36}$/.test(runId))
    throw new Error('invalid ownership identifier')
  if (
    host.root !== `${host.home}/ted-validation-lab` ||
    !path.isAbsolute(host.home) ||
    path.resolve(host.home) !== host.home ||
    host.home === '/'
  )
    throw new Error('invalid approved home/root')
  await plain(host.root)
  const identity = await identify()
  if (identity.machineId !== host.machineId || identity.home !== host.home)
    throw new Error('host/account identity mismatch')
  if (!/^v24\./.test(process.version)) throw new Error('Node 24 required')
  const owner = `${labId}:${identity.uid}:${identity.machineId}\n`
  const ownerFile = path.join(host.root, '.ted-lab-owner')
  if (!(await missing(host.root))) {
    const info = await lstat(host.root)
    if (info.uid !== identity.uid || (info.mode & 0o022) !== 0)
      throw new Error('scratch root must be account-owned and not writable by others')
  }
  const run = path.join(host.root, 'runs', runId)
  const source = path.join(run, 'source')
  const env = serviceEnvironment(host, run, source)
  const minimal = {
    HOME: host.home,
    PATH: `${path.dirname(host.node)}:/usr/bin:/bin:/usr/sbin:/sbin`,
  }
  const free = await statfs(host.home)
  const freeBytes = Number(free.bavail) * Number(free.bsize)
  if (action === 'identity') return { ...identity, freeBytes }
  if (action === 'preflight') {
    if (!(await missing(host.root))) {
      await plain(ownerFile, false)
      if ((await readFile(ownerFile, 'utf8')) !== owner)
        throw new Error('scratch root is not owned by this lab')
    }
    const pnpm = await must(host.node, [host.pnpm, '--version'], minimal, host.home)
    if (pnpm !== '10.28.0') throw new Error('pnpm 10.28.0 required')
    const git = await must('/usr/bin/git', ['--version'], minimal, host.home)
    await must(
      '/usr/bin/sandbox-exec',
      ['-p', '(version 1)(allow default)', '/usr/bin/true'],
      minimal,
      host.home,
    )
    if (freeBytes < 5 * 1024 ** 3) throw new Error('at least 5 GiB free required')
    return {
      ...identity,
      freeBytes,
      pnpm,
      git,
      sandbox: '/usr/bin/sandbox-exec',
      rootExists: !(await missing(host.root)),
    }
  }
  if (action === 'deploy' && (await missing(host.root))) {
    await mkdir(host.root, { mode: 0o700 })
    await writeFile(ownerFile, owner, { mode: 0o600, flag: 'wx' })
  }
  await plain(ownerFile, false)
  if ((await readFile(ownerFile, 'utf8')) !== owner)
    throw new Error('scratch root is not owned by this lab')
  if (action === 'deploy') {
    if (!request.files?.length || request.files.length > 5000)
      throw new Error('explicit candidate files required')
    const files = request.files
    const names = new Set<string>()
    let total = 0
    for (const file of files) {
      contentName(file.name)
      const bytes = Buffer.from(file.content, 'base64')
      total += bytes.length
      if (
        names.has(file.name) ||
        ![0o644, 0o755].includes(file.mode) ||
        digest(bytes) !== file.sha256 ||
        total > 32 * 1024 * 1024
      )
        throw new Error('invalid, duplicate or oversized candidate content')
      names.add(file.name)
    }
    await plain(path.dirname(run))
    await mkdir(path.dirname(run), { recursive: true, mode: 0o700 })
    await mkdir(run, { mode: 0o700 })
    await writeFile(path.join(run, '.owner'), owner, { mode: 0o600, flag: 'wx' })
    await mkdir(source)
    for (const file of files) {
      const target = path.join(source, file.name)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, Buffer.from(file.content, 'base64'), { mode: file.mode, flag: 'wx' })
    }
    await writeFile(
      path.join(run, 'manifest.json'),
      JSON.stringify(files.map(({ content: _, ...file }) => file)),
      { mode: 0o600 },
    )
    await writeFile(path.join(run, 'candidate.json'), JSON.stringify(request.candidate), {
      mode: 0o600,
    })
    for (const folder of ['ted-home', 'account', 'tmp', 'cache'])
      await mkdir(path.join(run, folder))
    await writeFile(path.join(run, 'gh.json'), '{}')
    return { ...identity, runId, contentHash: manifestDigest(files), files: files.length }
  }
  if (action === 'cleanup' && (await missing(run))) {
    if ((await markedProcesses(identity.uid ?? -1, runId, env.TED_HOME ?? '', minimal)).length)
      throw new Error(
        'run metadata absent but marked processes remain; refusing unverified cleanup',
      )
    return { removed: runId, alreadyAbsent: true, processStopped: true, rootPreserved: true }
  }
  await plain(run)
  await plain(path.join(run, '.owner'), false)
  if ((await readFile(path.join(run, '.owner'), 'utf8')) !== owner)
    throw new Error('run ownership mismatch')
  if (action === 'product') {
    if (
      !request.product ||
      !['start', 'stop', 'restart', 'status', 'pair', 'attempt', 'release', 'effects'].includes(
        request.product.operation,
      )
    )
      throw new Error('Invalid product operation')
    const adapter = path.join(source, 'scripts/execution-lab/product-worker.ts')
    await plain(adapter, false)
    const { productWorker } = await import(pathToFileURL(adapter).href)
    return productWorker(
      run,
      { ...env, TED_TEST_RUN: runId, TED_TEST_FILE: runId },
      request.product,
    )
  }
  if (action === 'verify') {
    await plain(path.join(run, 'manifest.json'), false)
    const files = JSON.parse(
      await readFile(path.join(run, 'manifest.json'), 'utf8'),
    ) as ContentFile[]
    for (const file of files) {
      const target = path.join(source, contentName(file.name))
      await plain(target, false)
      const info = await lstat(target)
      if (
        !info.isFile() ||
        (info.mode & 0o777) !== file.mode ||
        digest(await readFile(target)) !== file.sha256
      )
        throw new Error(`candidate mismatch: ${file.name}`)
    }
    return { contentHash: manifestDigest(files), files: files.length }
  }
  if (action === 'build') {
    await plain(source)
    const install = await must(
      host.node,
      [
        host.pnpm,
        'install',
        '--frozen-lockfile',
        '--ignore-scripts',
        '--store-dir',
        path.join(run, 'cache/store'),
      ],
      env,
      source,
      600_000,
    )
    const build = await must(
      host.node,
      [host.pnpm, '--filter', '@ted/app', 'build'],
      env,
      source,
      180_000,
    )
    const artifacts: { name: string; sha256: string }[] = []
    const walk = async (directory: string) => {
      await plain(directory)
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name)
        if (entry.isDirectory()) await walk(target)
        else if (entry.isFile())
          artifacts.push({
            name: path.relative(source, target),
            sha256: digest(await readFile(target)),
          })
        else throw new Error('unexpected build artifact link')
      }
    }
    await walk(path.join(source, 'packages/app/dist/renderer'))
    artifacts.sort((a, b) => a.name.localeCompare(b.name))
    if (!artifacts.length) throw new Error('renderer artifacts missing')
    await writeFile(path.join(run, 'artifacts.json'), JSON.stringify(artifacts), { mode: 0o600 })
    return { install, build, artifacts }
  }
  if (
    action === 'cleanup' &&
    !(await missing(path.join(run, 'execution-worker', 'control.json')))
  ) {
    const { productWorker } = await import(
      pathToFileURL(path.join(source, 'scripts/execution-lab/product-worker.ts')).href
    )
    try {
      await productWorker(run, env, { operation: 'stop' })
    } catch (error) {
      if (
        !(
          error &&
          typeof error === 'object' &&
          'code' in error &&
          ['ECONNREFUSED', 'ENOENT'].includes(String(error.code))
        )
      )
        throw error
    }
  }
  if (action === 'scenario') {
    if (!request.scenarios?.length) throw new Error('select implementation scenarios explicitly')
    const reports = path.join(host.root, 'reports', runId)
    await plain(reports)
    const reportOwner = path.join(reports, '.owner')
    if (await missing(reports)) {
      await mkdir(path.dirname(reports), { recursive: true, mode: 0o700 })
      await mkdir(reports, { mode: 0o700 })
      await writeFile(reportOwner, owner, { flag: 'wx', mode: 0o600 })
    }
    await plain(reportOwner, false)
    if ((await readFile(reportOwner, 'utf8')) !== owner)
      throw new Error('scenario report ownership mismatch')
    await plain(path.join(run, 'candidate.json'), false)
    const candidate = JSON.parse(await readFile(path.join(run, 'candidate.json'), 'utf8'))
    if (JSON.stringify(candidate) !== JSON.stringify(request.candidate))
      throw new Error('deployed candidate differs from requested scenario candidate; deploy again')
    const code = `const {runValidation} = await import(${JSON.stringify(pathToFileURL(path.join(source, 'scripts/validate-execution.ts')).href)}); const {mkdtemp} = await import('node:fs/promises'); const result = await runValidation({root:${JSON.stringify(source)}, reportDir:${JSON.stringify(reports)}, scenarios:${JSON.stringify(request.scenarios)}}, {candidate:async()=>(${JSON.stringify(candidate)}),reportDirectory:async(requested)=>{if(requested!==${JSON.stringify(reports)})throw Error('report destination changed');return mkdtemp(requested+'/validation-')}}); console.log(JSON.stringify({code:result.code,directory:result.directory})); process.exitCode=result.code;`
    const result = await command(
      host.node,
      ['--input-type=module', '-e', code],
      { ...env, HOME: host.home },
      source,
      Math.min(Math.max(request.timeoutMs ?? 2_400_000, 900_000), 12 * 60 * 60 * 1000),
    )
    let location: { directory: string }
    try {
      location = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '') as { directory: string }
    } catch {
      throw new Error(
        `implementation scenario produced no report location (${result.code}): ${result.stderr}\n${result.stdout}`,
      )
    }
    await plain(location.directory)
    if (!location.directory.startsWith(`${reports}/validation-`))
      throw new Error('scenario report escaped run')
    const reportFile = path.join(location.directory, 'report.json')
    await plain(reportFile, false)
    if ((await lstat(reportFile)).size > 256 * 1024)
      throw new Error('scenario report exceeds evidence bound')
    const report = JSON.parse(await readFile(reportFile, 'utf8')) as {
      scenarios?: { evidencePaths?: string[] }[]
    }
    const evidence: { name: string; text: string }[] = []
    for (const scenario of report.scenarios ?? [])
      for (const name of scenario.evidencePaths ?? []) {
        if (evidence.length >= 5 || !/^[a-z0-9-]+\.(txt|json)$/.test(name)) continue
        const target = path.join(location.directory, name)
        await plain(target, false)
        if ((await lstat(target)).size > 256 * 1024)
          throw new Error('scenario evidence exceeds bound')
        evidence.push({ name, text: (await readFile(target, 'utf8')).slice(0, 16 * 1024) })
      }
    return {
      exitCode: result.code,
      result: report,
      evidence,
      stdout: result.stdout.slice(0, 16384),
      stderr: result.stderr.slice(0, 16384),
    }
  }
  const transport = action === 'connect' || action === 'disconnect'
  const serviceName = transport ? 'transport' : 'service'
  const receiptFile = path.join(run, `${serviceName}.json`)
  const readReceipt = async () => {
    await plain(receiptFile, false)
    return JSON.parse(await readFile(receiptFile, 'utf8')) as ProcessReceipt
  }
  const owned = async (receipt: ProcessReceipt) => {
    if (
      !Number.isSafeInteger(receipt.pid) ||
      receipt.pid < 2 ||
      !/^[a-f0-9-]{36}$/.test(receipt.token)
    )
      throw new Error('invalid process receipt')
    const current = await processIdentity(receipt.pid, minimal)
    if (!current) return false
    if (
      current !== receipt.identity ||
      !current.includes(receipt.token) ||
      !current.includes(path.join(run, `${serviceName}.mjs`)) ||
      !current.startsWith(`${identity.uid} `)
    )
      throw new Error('process ownership changed; refusing signal')
    return true
  }
  const stop = async () => {
    if (await missing(receiptFile)) return { stopped: false }
    const receipt = await readReceipt()
    if (await owned(receipt)) {
      process.kill(receipt.pid, 'SIGTERM')
      const inspect = (pid: number) => processIdentity(pid, minimal)
      if (!(await waitForProcessExit(receipt.pid, 50, inspect))) {
        if (await owned(receipt)) process.kill(receipt.pid, 'SIGKILL')
        if (!(await waitForProcessExit(receipt.pid, 30, inspect)))
          throw new Error('owned process did not exit')
      }
    }
    await rm(receiptFile)
    return { stopped: true, pid: receipt.pid }
  }
  const start = async () => {
    if (!(await missing(receiptFile)))
      throw new Error('service receipt already exists; use restart')
    const token = randomUUID()
    const service = path.join(run, `${serviceName}.mjs`)
    await plain(service, false)
    let target: number | undefined
    let targetToken: string | undefined
    let targetPid: number | undefined
    if (transport) {
      await plain(path.join(run, 'service.json'), false)
      await plain(path.join(run, 'heartbeat.json'), false)
      const serviceReceipt = JSON.parse(
        await readFile(path.join(run, 'service.json'), 'utf8'),
      ) as ProcessReceipt
      const current = await processIdentity(serviceReceipt.pid, minimal)
      if (
        current !== serviceReceipt.identity ||
        !current.includes(path.join(run, 'service.mjs')) ||
        !current.includes(serviceReceipt.token)
      )
        throw new Error('transport target is not an owned service')
      const beat = JSON.parse(await readFile(path.join(run, 'heartbeat.json'), 'utf8')) as {
        port: number
        token: string
      }
      if (
        beat.token !== serviceReceipt.token ||
        !Number.isInteger(beat.port) ||
        beat.port < 1 ||
        beat.port > 65535
      )
        throw new Error('invalid owned transport endpoint')
      target = beat.port
      targetToken = serviceReceipt.token
      targetPid = serviceReceipt.pid
    }
    await writeFile(
      service,
      `import { writeFileSync, appendFileSync } from 'node:fs';\nimport net from 'node:net';\nlet sequence = 0;\nconst server = net.createServer(socket => { ${transport ? `const remote = net.connect(${target}, '127.0.0.1'); socket.pipe(remote).pipe(socket); remote.on('error', () => socket.destroy()); socket.on('error', () => remote.destroy());` : `socket.end(JSON.stringify({pid:process.pid,sequence,token:process.argv[3]})); socket.on('error',()=>{});`} });\nconst beat = () => writeFileSync(process.argv[2], JSON.stringify({pid:process.pid,token:process.argv[3],sequence:++sequence,port:server.address().port}));\nserver.listen(0,'127.0.0.1',()=>{appendFileSync(process.argv[4],process.argv[3]+'\\n'); beat(); setInterval(beat,200);});\n`,
    )
    const heartbeat = path.join(run, transport ? 'transport-heartbeat.json' : 'heartbeat.json')
    await plain(heartbeat, false)
    const starts = path.join(run, `${serviceName}-starts.txt`)
    await plain(starts, false)
    const child = spawn(host.node, [service, heartbeat, token, starts], {
      cwd: run,
      env,
      detached: true,
      stdio: 'ignore',
    })
    const pid = await new Promise<number>((resolve, reject) => {
      child.once('error', reject)
      child.once('spawn', () => (child.pid ? resolve(child.pid) : reject(new Error('missing pid'))))
    })
    child.unref()
    const receipt = { pid, token, identity: await processIdentity(pid, minimal) }
    if (!receipt.identity) throw new Error('owned service exited during start')
    try {
      await writeFile(receiptFile, JSON.stringify(receipt), { mode: 0o600, flag: 'wx' })
    } catch (error) {
      child.kill('SIGKILL')
      throw error
    }
    for (let tries = 0; tries < 50; tries++) {
      const beat = await readFile(heartbeat, 'utf8')
        .then((text) => {
          try {
            return JSON.parse(text) as { token: string; port: number }
          } catch {
            return undefined
          }
        })
        .catch(() => undefined)
      if (beat?.token === token && beat.port > 0) {
        if (transport) {
          try {
            const reply = await exchange(beat.port)
            if (reply.token !== targetToken || reply.pid !== targetPid)
              throw new Error('relay reached a different service')
          } catch (error) {
            await stop()
            throw error
          }
        }
        return { pid, token, port: beat.port, ...(transport ? { relayTargetConfirmed: true } : {}) }
      }
      if (!(await owned(receipt))) break
      await delay(100)
    }
    await stop()
    throw new Error('owned process did not become ready')
  }
  if (action === 'start') return start()
  if (action === 'stop') return stop()
  if (action === 'connect') return start()
  if (action === 'disconnect') return stop()
  if (action === 'restart') {
    const previous = await stop()
    return { previous, current: await start() }
  }
  if (action === 'observe') {
    const receipt = await readReceipt()
    await plain(path.join(run, 'heartbeat.json'), false)
    await plain(path.join(run, 'service-starts.txt'), false)
    const observationFile = path.join(run, 'last-observed.json')
    await plain(observationFile, false)
    const previous = await readFile(observationFile, 'utf8')
      .then((text) => JSON.parse(text) as { token: string; sequence: number })
      .catch(() => undefined)
    for (let tries = 0; tries < 50; tries++) {
      if (!(await owned(receipt))) throw new Error('owned process is not live')
      const beat = await readFile(path.join(run, 'heartbeat.json'), 'utf8')
        .then((text) => {
          try {
            return JSON.parse(text) as {
              pid: number
              token: string
              sequence: number
              port: number
            }
          } catch {
            return undefined
          }
        })
        .catch(() => undefined)
      if (
        beat?.token === receipt.token &&
        beat.pid === receipt.pid &&
        beat.sequence >= 2 &&
        (previous?.token !== beat.token || beat.sequence > previous.sequence)
      ) {
        await writeFile(
          observationFile,
          JSON.stringify({ token: beat.token, sequence: beat.sequence }),
        )
        return {
          ...beat,
          starts: (await readFile(path.join(run, 'service-starts.txt'), 'utf8')).trim().split('\n')
            .length,
        }
      }
      await delay(100)
    }
    throw new Error('owned process produced no progress')
  }
  if (action === 'probe') {
    const allowed = path.join(run, 'sandbox-allowed')
    const denied = path.join(run, 'sandbox-denied')
    await plain(allowed, false)
    await plain(denied, false)
    await writeFile(path.join(run, 'scratch-write'), 'scratch')
    const policy = `(version 1)(allow default)(deny file-write*)(allow file-write* (literal ${JSON.stringify(allowed)}))`
    await must(
      '/usr/bin/sandbox-exec',
      ['-p', policy, '/bin/sh', '-c', 'printf allowed > "$1"', 'lab', allowed],
      env,
      run,
    )
    const refusal = await command(
      '/usr/bin/sandbox-exec',
      ['-p', policy, '/bin/sh', '-c', 'printf denied > "$1"', 'lab', denied],
      env,
      run,
    )
    if (
      refusal.code === 0 ||
      !(await missing(denied)) ||
      (await readFile(allowed, 'utf8')) !== 'allowed'
    )
      throw new Error('native sandbox failed allow/deny probe')
    const fixtures = path.join(run, 'fixtures')
    await plain(fixtures)
    await mkdir(fixtures, { recursive: true })
    const fixture = path.join(fixtures, randomUUID())
    await mkdir(fixture)
    await must(
      '/usr/bin/git',
      ['init', '--bare', '--initial-branch=main', path.join(fixture, 'remote.git')],
      env,
      run,
    )
    await must('/usr/bin/git', ['init', '-b', 'main', path.join(fixture, 'seed')], env, run)
    await writeFile(path.join(fixture, 'seed/README.md'), 'Synthetic lab repository\n')
    await must('/usr/bin/git', ['add', 'README.md'], env, path.join(fixture, 'seed'))
    await must(
      '/usr/bin/git',
      ['commit', '-m', 'Synthetic fixture'],
      env,
      path.join(fixture, 'seed'),
    )
    await must(
      '/usr/bin/git',
      ['push', path.join(fixture, 'remote.git'), 'main'],
      env,
      path.join(fixture, 'seed'),
    )
    await must(
      '/usr/bin/git',
      ['clone', '--local', path.join(fixture, 'remote.git'), path.join(fixture, 'read-probe')],
      env,
      run,
    )
    if (
      (await readFile(path.join(fixture, 'read-probe/README.md'), 'utf8')) !==
      'Synthetic lab repository\n'
    )
      throw new Error('fixture endpoint could not be read')
    return {
      scratchWrite: true,
      nativeAllowed: true,
      nativeDenied: true,
      denial: refusal.stderr,
      fixtureRemote: path.join(fixture, 'remote.git'),
      fixtureReadVerified: true,
      fixtureScope:
        'reachable on this host only; future cross-host scenarios must arrange reachable endpoints',
    }
  }
  if (action === 'cleanup') {
    await dispatch({ ...request, action: 'disconnect' }, identify)
    await stop()
    const reaped: number[] = []
    for (let round = 0; round < 20; round++) {
      const remaining = await markedProcesses(
        identity.uid ?? -1,
        runId,
        env.TED_HOME ?? '',
        minimal,
      )
      if (!remaining.length) break
      for (const entry of remaining) {
        const current = await command(
          '/bin/ps',
          ['eww', '-p', String(entry.pid), '-o', 'uid=,lstart=,command='],
          minimal,
          '/',
        )
        if (current.code === 0 && current.stdout.trim() === entry.identity) {
          try {
            process.kill(entry.pid, 'SIGKILL')
            reaped.push(entry.pid)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
          }
        }
      }
      await delay(100)
    }
    if ((await markedProcesses(identity.uid ?? -1, runId, env.TED_HOME ?? '', minimal)).length)
      throw new Error('marked processes remain; preserving scratch')
    await plain(run)
    if (
      (await realpath(run)) !== run ||
      (await readFile(path.join(run, '.owner'), 'utf8')) !== owner
    )
      throw new Error('cleanup ownership changed')
    await rm(run, { recursive: true, force: false })
    if (!(await missing(run))) throw new Error('cleanup verification failed')
    return { removed: runId, processStopped: true, reaped, rootPreserved: true }
  }
  throw new Error('unknown lab action')
}
