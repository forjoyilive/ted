import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { redactSecrets } from '../../packages/daemon/src/redact.ts'
import {
  executionManifest,
  selectScenarios,
} from '../../packages/daemon/test/support/execution-manifest.ts'
import {
  type Candidate,
  candidateIdentity,
  machineIdentity,
  publishReport,
  reportDirectory,
  saveEvidence,
  type ValidationReport,
} from '../../packages/daemon/test/support/execution-report.ts'
import { type LabConfig, type LabHost, plainPath, quote, readConfig, sshArgs } from './config.ts'
import { type ContentFile, contentName, digest, type HostRequest, manifestDigest } from './host.ts'

export interface LabCommand {
  program: string
  args: string[]
  input: string
  timeout: number
}
export interface LabOutput {
  code: number
  stdout: string
  stderr: string
}
export type Execute = (command: LabCommand) => Promise<LabOutput>

export const execute: Execute = async ({ program, args, input, timeout }) =>
  new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    }
    if (process.env.SSH_AUTH_SOCK) env.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK
    const child = spawn(program, args, { env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let overflow = false
    let expired = false
    const kill = (signal: NodeJS.Signals) => {
      if (child.pid)
        try {
          process.kill(-child.pid, signal)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
    }
    const collect = (previous: string, data: Buffer) => {
      if (Buffer.byteLength(previous) + data.length > 512 * 1024) {
        overflow = true
        kill('SIGTERM')
      }
      return (previous + data.toString()).slice(0, 512 * 1024)
    }
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = collect(stdout, chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = collect(stderr, chunk)
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
    const timer = setTimeout(() => {
      expired = true
      kill('SIGTERM')
    }, timeout)
    const force = setTimeout(() => kill('SIGKILL'), timeout + 3000)
    child.on('error', (error) => {
      clearTimeout(timer)
      clearTimeout(force)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      clearTimeout(force)
      if (expired || overflow) kill('SIGKILL')
      resolve({
        code: expired || overflow ? 1 : (code ?? 1),
        stdout,
        stderr:
          stderr +
          (expired ? '\nTimed out; remote state requires inspection.' : '') +
          (overflow ? '\nOutput exceeded limit.' : ''),
      })
    })
  })

export function hostCommand(config: LabConfig, host: LabHost, input: string): LabCommand {
  const args = [
    '-i',
    `HOME=${host.home}`,
    `PATH=${path.dirname(host.node)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    host.node,
    '--input-type=module-typescript',
    '-',
  ]
  return host.connection === 'local'
    ? { program: '/usr/bin/env', args, input, timeout: 900_000 }
    : {
        program: '/usr/bin/ssh',
        args: [...sshArgs(config, host), ['/usr/bin/env', ...args].map(quote).join(' ')],
        input,
        timeout: 900_000,
      }
}

export async function callHost(
  config: LabConfig,
  host: LabHost,
  request: HostRequest,
  run: Execute = execute,
) {
  const implementation = await readFile(new URL('./host.ts', import.meta.url), 'utf8')
  const timeout =
    request.action === 'scenario'
      ? 30_000 +
        selectScenarios(request.scenarios ?? []).reduce(
          (total, scenario) => total + scenario.timeoutMs + 1_820_000,
          0,
        )
      : 900_000
  const input = `${implementation}\ntry { console.log('TED_LAB_RESULT=' + JSON.stringify(await dispatch(${JSON.stringify({ ...request, timeoutMs: timeout })}))) } catch(error) { console.error(String(error)); process.exitCode = 1 }\n`
  const output = await run({ ...hostCommand(config, host, input), timeout: timeout + 10_000 })
  if (output.code !== 0)
    throw new Error(
      redactSecrets(
        `${host.role}: ${output.stderr || output.stdout || `command exited ${output.code}`}`,
      ),
    )
  const line = output.stdout.split('\n').find((value) => value.startsWith('TED_LAB_RESULT='))
  if (!line) throw new Error(`${host.role}: missing host result`)
  const value: unknown = JSON.parse(line.slice('TED_LAB_RESULT='.length))
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid host result')
  return value as Record<string, unknown>
}

export async function candidateFiles(root: string, run: Execute = execute) {
  const result = await run({
    program: '/usr/bin/git',
    args: [
      '--no-optional-locks',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.hooksPath=/dev/null',
      '-C',
      root,
      'ls-tree',
      '-rz',
      '--full-tree',
      'HEAD',
    ],
    input: '',
    timeout: 30_000,
  })
  if (result.code !== 0) throw new Error('cannot enumerate committed candidate')
  const files: ContentFile[] = []
  let total = 0
  for (const entry of result.stdout.split('\0').filter(Boolean)) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(entry)
    if (!match) throw new Error('candidate must contain only ordinary tracked files')
    const name = contentName(match[3] ?? '')
    const target = path.join(root, name)
    await plainPath(target)
    const info = await lstat(target)
    if (!info.isFile()) throw new Error(`candidate file is not plain: ${name}`)
    const bytes = await readFile(target)
    total += bytes.length
    if (total > 32 * 1024 * 1024) throw new Error('candidate exceeds 32 MiB limit')
    const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
    if (blob !== match[2] || (info.mode & 0o111 ? '100755' : '100644') !== match[1])
      throw new Error(`commit candidate changes before deployment: ${name}`)
    files.push({
      name,
      mode: match[1] === '100755' ? 0o755 : 0o644,
      sha256: digest(bytes),
      content: bytes.toString('base64'),
    })
  }
  return files
}

export interface LabOptions {
  optIn: boolean
  configFile: string
  root: string
  action: 'dry-run' | 'preflight' | 'acceptance' | 'deploy' | HostRequest['action'] | 'scenario'
  scenarios: string[]
  runId?: string
}

export async function runLab(options: LabOptions, run: Execute = execute, publish = publishReport) {
  if (!options.optIn) throw new Error('--opt-in required before reading host configuration')
  const config = await readConfig(options.configFile, options.root)
  if (!options.scenarios.length) throw new Error('explicit --scenario required')
  const selected = options.scenarios.filter((id) => id !== 'lab-access')
  if (selected.length) selectScenarios(selected)
  if (
    options.action === 'acceptance' &&
    (options.scenarios.length !== 1 ||
      !['lab-access', 'product-pairing', 'product-commands'].includes(options.scenarios[0] ?? ''))
  )
    throw new Error(
      'acceptance selects only lab-access, product-pairing or product-commands; use --action scenario for other implementation scenarios',
    )
  const id = options.runId ?? randomUUID()
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('invalid run id')
  if (!['dry-run', 'preflight', 'acceptance', 'deploy'].includes(options.action) && !options.runId)
    throw new Error('--run-id required to control an existing owned run')
  const replay = [
    'node',
    'scripts/validate-execution-lab.ts',
    '--opt-in',
    '--config',
    options.configFile,
    '--action',
    options.action,
    ...options.scenarios.flatMap((scenario) => ['--scenario', scenario]),
    ...(options.runId ? ['--run-id', id] : []),
  ]
  if (options.action === 'dry-run')
    return {
      code: 0,
      plan: {
        runId: id,
        action: 'no host contact',
        hosts: config.hosts.map(({ role, connection, root, machineId }) => ({
          role,
          connection,
          root,
          machineId,
        })),
        replay,
      },
    }
  let directory: string
  try {
    directory = await reportDirectory(config.reportDir, options.root)
  } catch (error) {
    if (options.action !== 'cleanup') throw error
    const recovery: unknown[] = []
    for (const host of config.hosts) {
      try {
        recovery.push({
          role: host.role,
          result: await callHost(
            config,
            host,
            { labId: config.labId, host, action: 'cleanup', runId: id },
            run,
          ),
        })
      } catch (failure) {
        recovery.push({ role: host.role, error: String(failure) })
      }
    }
    throw new Error(
      redactSecrets(
        `Report storage unavailable for run ${id}; cleanup attempted on both hosts without report writes: ${JSON.stringify(recovery)}. ${error}`,
      ),
    )
  }
  const started = Date.now()
  const report: ValidationReport = {
    version: 1,
    manifestVersion: executionManifest.version,
    candidate: null,
    prerequisites: {},
    machine: machineIdentity(),
    startedAt: new Date().toISOString(),
    durationMs: 0,
    result: 'fail',
    scenarios: [],
    errors: [],
    replay: {
      command: replay,
      candidate: null,
      instruction: `Lab run ${id}. Restore the recorded clean candidate. Configuration/SSH keys stay on the controller. Existing-run actions require --run-id ${id}. Lab-access proves infrastructure only, not remote TED execution. Inspect/stop/cleanup this run after interruption; never delete or kill unowned resources.`,
    },
  }
  const deployed: LabHost[] = []
  let publicationError: unknown
  const step = async (host: LabHost, action: HostRequest['action'], files?: ContentFile[]) => {
    const result = {
      id: `${host.role}:${action}`,
      evidence: 'actual two-Mac execution' as const,
      scope: 'lab infrastructure only',
      command: [host.connection, host.role, action, id],
      prerequisites: ['pinned host/account identity', 'owned root'],
      expected: [action],
      observed: [] as unknown[],
      result: 'fail' as 'fail' | 'pass',
      durationMs: 0,
      evidencePaths: [] as string[],
    }
    report.scenarios.push(result)
    if (action !== 'cleanup') await publish(directory, report)
    const before = Date.now()
    let observed: Record<string, unknown> | undefined
    let failure: unknown
    try {
      observed = await callHost(
        config,
        host,
        {
          labId: config.labId,
          host,
          action,
          runId: id,
          ...(files && { files }),
          ...(report.candidate && { candidate: report.candidate }),
          scenarios: selected,
        },
        run,
      )
      result.observed.push(observed)
      if (action === 'scenario' && observed.exitCode !== 0)
        throw new Error(`${host.role}: scenario failed or skipped; see collected observations`)
      result.result = 'pass'
    } catch (error) {
      failure = error ?? new Error('host action failed')
      result.observed.push({ error: redactSecrets(String(error)) })
    }
    result.durationMs = Date.now() - before
    try {
      await publish(directory, report)
    } catch (error) {
      report.errors.push(redactSecrets(`report publication after ${action}: ${error}`))
      if (action !== 'cleanup') failure ??= error
    }
    if (failure !== undefined) throw failure
    if (!observed) throw new Error('host action returned no observations')
    return observed
  }
  try {
    if (options.action !== 'cleanup') {
      await publish(directory, report)
      report.candidate = await candidateIdentity(options.root)
    }
    report.replay.candidate = report.candidate
    if (
      report.candidate?.dirtyPatchIdentity &&
      ['acceptance', 'deploy', 'scenario'].includes(options.action)
    )
      throw new Error('commit candidate before lab execution')
    const preflight = []
    const recovering = ['cleanup', 'stop', 'disconnect', 'observe'].includes(options.action)
    const readiness = ['preflight', 'acceptance', 'deploy', 'build', 'probe', 'scenario'].includes(
      options.action,
    )
      ? 'preflight'
      : 'identity'
    if (!recovering) for (const host of config.hosts) preflight.push(await step(host, readiness))
    if (!recovering && preflight[0]?.machineId === preflight[1]?.machineId)
      throw new Error('same actual Mac returned for both roles')
    if (options.action === 'preflight') report.result = 'pass'
    else if (options.action === 'acceptance' || options.action === 'deploy') {
      const files = await candidateFiles(options.root, run)
      const expected = manifestDigest(files)
      const manifest = JSON.stringify(
        files.map(({ content: _, ...file }) => file),
        null,
        2,
      )
      if (Buffer.byteLength(manifest) > 256 * 1024)
        throw new Error('candidate manifest exceeds report bound')
      await saveEvidence(directory, 'candidate-manifest.json', manifest)
      report.prerequisites.contentManifestSha256 = expected
      const artifacts: unknown[] = []
      for (const host of config.hosts) {
        deployed.push(host)
        const deployment = await step(host, 'deploy', files)
        if (deployment.contentHash !== expected)
          throw new Error(`${host.role}: deployed content differs`)
        artifacts.push((await step(host, 'build')).artifacts)
        if ((await step(host, 'verify')).contentHash !== expected)
          throw new Error(`${host.role}: source changed during build`)
        if (options.action === 'acceptance' && options.scenarios[0] === 'lab-access') {
          await step(host, 'probe')
          await step(host, 'start')
          const first = await step(host, 'observe')
          await step(host, 'connect')
          await step(host, 'disconnect')
          const disconnected = await step(host, 'observe')
          if (
            first.pid !== disconnected.pid ||
            first.token !== disconnected.token ||
            first.starts !== disconnected.starts ||
            Number(disconnected.sequence) <= Number(first.sequence)
          )
            throw new Error('service changed while only fixture transport was disconnected')
          await step(host, 'stop')
          await step(host, 'start')
          const second = await step(host, 'observe')
          if (first.token === second.token)
            throw new Error('restart did not create a fresh process')
          await step(host, 'stop')
        }
      }
      const product = (['product-pairing', 'product-commands'] as const).find((name) =>
        selected.includes(name),
      )
      if (options.action === 'acceptance' && product) {
        const controller = config.hosts[0],
          executor = config.hosts[1]
        const result = {
          id: product,
          evidence: 'actual two-Mac execution' as const,
          scope: 'production behavior',
          command: replay,
          prerequisites: [
            'two pinned actual Macs',
            'same reachable local network',
            'committed product transport',
          ],
          expected: [
            'two-mac-pairing',
            'two-mac-worker-restart',
            'two-mac-peer-refusal',
            'two-mac-revocation',
            ...(product === 'product-commands'
              ? ['two-mac-command-once', 'two-mac-service-restarts', 'two-mac-stale-refused']
              : []),
          ],
          observed: [] as unknown[],
          result: 'fail' as 'pass' | 'fail',
          durationMs: 0,
          evidencePaths: [] as string[],
        }
        report.scenarios.push(result)
        await publish(directory, report)
        const started = Date.now()
        const { productPairing } = await import(
          pathToFileURL(
            path.join(
              controller.root,
              'runs',
              id,
              'source/scripts/execution-lab/product-pairing.ts',
            ),
          ).href
        )
        const observations = await productPairing({
          run: path.join(controller.root, 'runs', id),
          remoteAddress: executor.address,
          commands: product === 'product-commands',
          worker: (product: unknown) =>
            callHost(
              config,
              executor,
              {
                labId: config.labId,
                host: executor,
                action: 'product',
                runId: id,
                product: product as NonNullable<HostRequest['product']>,
              },
              run,
            ),
        })
        if (!result.expected.every((invariant) => observations.invariants.includes(invariant)))
          throw new Error('Product evidence is incomplete')
        result.observed.push({
          ...observations,
          hosts: preflight.map((host) => ({ machineId: host.machineId, hostname: host.hostname })),
        })
        result.durationMs = Date.now() - started
        result.result = 'pass'
        await publish(directory, report)
      }
      if (JSON.stringify(artifacts[0]) !== JSON.stringify(artifacts[1]))
        throw new Error('build artifacts differ across Macs')
      report.result = 'pass'
    } else {
      if (options.action === 'scenario' && !selected.length)
        throw new Error('select implementation scenarios, not lab-access')
      for (const host of config.hosts) {
        try {
          if (recovering && options.action !== 'cleanup') await step(host, 'identity')
          await step(host, options.action)
        } catch (error) {
          report.errors.push(redactSecrets(`${host.role}: ${error}`))
        }
      }
      report.result = 'pass'
    }
  } catch (error) {
    report.errors.push(redactSecrets(String(error)))
    try {
      await saveEvidence(directory, 'failure.txt', String(error))
    } catch (publicationError) {
      report.errors.push(redactSecrets(`failure evidence unavailable: ${publicationError}`))
    }
  } finally {
    if (options.action === 'acceptance') {
      for (const host of deployed.reverse()) {
        try {
          await step(host, 'cleanup')
        } catch (error) {
          report.errors.push(redactSecrets(`Cleanup ${host.role}: ${error}`))
        }
      }
    }
    if (report.errors.length || report.scenarios.some((scenario) => scenario.result === 'fail'))
      report.result = 'fail'
    report.durationMs = Date.now() - started
    try {
      await publish(directory, report)
    } catch (error) {
      publicationError = error
    }
  }
  if (publicationError !== undefined)
    throw new Error(
      redactSecrets(
        `Report publication failed for run ${id}; owned acceptance cleanup was attempted independently. Reports: ${directory}. ${publicationError}`,
      ),
    )
  return { code: report.result === 'pass' ? 0 : 1, directory, report, runId: id }
}

export async function bootstrap(config: LabConfig, run: Execute = execute) {
  const input = `${await readFile(new URL('./bootstrap-paths.sh', import.meta.url), 'utf8')}\n${await readFile(new URL('./bootstrap.sh', import.meta.url), 'utf8')}`
  const results = []
  for (const host of config.hosts) {
    const args = [
      '-i',
      `HOME=${host.home}`,
      'PATH=/usr/bin:/bin:/usr/sbin:/sbin',
      '/bin/sh',
      '-s',
      '--',
      host.root,
      config.labId,
      host.machineId,
      host.home,
    ]
    const command: LabCommand =
      host.connection === 'local'
        ? { program: '/usr/bin/env', args, input, timeout: 600_000 }
        : {
            program: '/usr/bin/ssh',
            args: [...sshArgs(config, host), ['/usr/bin/env', ...args].map(quote).join(' ')],
            input,
            timeout: 600_000,
          }
    const result = await run(command)
    if (result.code !== 0)
      throw new Error(
        redactSecrets(`bootstrap ${host.role} failed: ${result.stderr || result.stdout}`),
      )
    results.push({ role: host.role, output: result.stdout })
  }
  return results
}

export const checkoutRoot = fileURLToPath(new URL('../..', import.meta.url))
export type { Candidate }
