import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { observe } from '../packages/daemon/test/support/execution-observations.ts'
import { publishReport } from '../packages/daemon/test/support/execution-report.ts'
import { parseConfig, plainPath, quote, readConfig, sshArgs } from './execution-lab/config.ts'
import {
  contentName,
  digest,
  dispatch,
  type HostRequest,
  manifestDigest,
  markedListing,
  serviceEnvironment,
  waitForProcessExit,
} from './execution-lab/host.ts'
import { productPairing, supportedLanRoute } from './execution-lab/product-pairing.ts'
import {
  bootstrap,
  callHost,
  candidateFiles,
  execute,
  type LabCommand,
  runLab,
} from './execution-lab/runner.ts'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})
const config = () => ({
  version: 1,
  labId: 'lab-test-v1',
  knownHosts: '/Users/controller/.config/lab/known_hosts',
  identityFile: '/Users/controller/.ssh/lab',
  reportDir: '/Users/controller/.cache/lab-reports',
  hosts: [
    {
      role: 'controller',
      connection: 'local',
      home: '/Users/controller',
      root: '/Users/controller/ted-validation-lab',
      machineId: '11111111-1111-1111-1111-111111111111',
      node: '/opt/node',
      pnpm: '/opt/pnpm',
    },
    {
      role: 'executor',
      connection: 'ssh',
      home: '/Users/executor',
      root: '/Users/executor/ted-validation-lab',
      machineId: '22222222-2222-2222-2222-222222222222',
      node: '/opt/node',
      pnpm: '/opt/pnpm',
      address: '192.0.2.1',
      user: 'executor',
      port: 22,
    },
  ],
})
async function scratch() {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'lab-tests-'))
  directories.push(directory)
  return directory
}

describe('lab configuration and SSH control', () => {
  it('requires the OS route to use the recorded local Wi-Fi or Ethernet interface', async () => {
    const address = '192.168.88.20'
    const interfaces = {
      en0: [
        {
          address,
          internal: false,
          family: 'IPv4' as const,
          netmask: '255.255.255.0',
          mac: '00:11:22:33:44:55',
          cidr: `${address}/24`,
        },
      ],
    }
    const hardware = 'Hardware Port: Wi-Fi\nDevice: en0\nEthernet Address: 00:11:22:33:44:55\n'
    expect(supportedLanRoute(address, ' interface: en0\n', hardware, interfaces)).toEqual({
      address,
      interface: 'en0',
      hardwarePort: 'Wi-Fi',
    })
    expect(
      supportedLanRoute(
        address,
        ' interface: en0\n',
        hardware.replace('Wi-Fi', 'USB Ethernet'),
        interfaces,
      ).hardwarePort,
    ).toBe('USB Ethernet')
    for (const route of [' interface: utun4\n', ' interface: bridge0\n', ' interface: en1\n', ''])
      expect(() => supportedLanRoute(address, route, hardware, interfaces)).toThrow(
        'verified local',
      )
    expect(() =>
      supportedLanRoute(
        address,
        ' interface: en0\n',
        'Hardware Port: VPN\nDevice: en0\n',
        interfaces,
      ),
    ).toThrow('verified local')
    expect(() =>
      supportedLanRoute('192.168.88.21', ' interface: en0\n', hardware, interfaces),
    ).toThrow('verified local')
    await observe('pairing-lab-interface', {
      wifiAndEthernet: 'supported with matching assigned address',
      tunnelBridgeMissingAndUnassigned: 'refused before product transport',
    })
  })

  it('product pairing cleans its real controller fixture without replacing the original failure', async () => {
    const run = path.join(await scratch(), randomUUID())
    await mkdir(run)
    await expect(
      productPairing({
        run,
        remoteAddress: '127.0.0.1',
        worker: async () => {
          throw new Error('must not contact a worker before route validation')
        },
      }),
    ).rejects.toThrow('Real two-Mac pairing requires a non-loopback local address')
    await expect(access(path.join(run, 'ted-execution-pairing'))).rejects.toThrow()
    await observe('pairing-lab-cleanup', {
      originalFailure: 'non-loopback route required',
      controllerFixture: 'removed through owned fixture cleanup',
    })
  }, 60_000)
  it('can recover both hosts when report allocation or publication is unavailable', async () => {
    for (const phase of ['allocation', 'publication']) {
      const directory = await scratch()
      const value = config()
      value.knownHosts = `${directory}/known_hosts`
      value.identityFile = `${directory}/identity`
      value.reportDir = `${directory}/reports`
      await writeFile(value.knownHosts, '')
      await writeFile(value.identityFile, '', { mode: 0o600 })
      if (phase === 'allocation') await writeFile(value.reportDir, 'not a directory')
      const file = `${directory}/config.json`
      await writeFile(file, JSON.stringify(value))
      const contacted: string[] = []
      await expect(
        runLab(
          {
            optIn: true,
            configFile: file,
            root: process.cwd(),
            action: 'cleanup',
            scenarios: ['lab-access'],
            runId: '33333333-3333-3333-3333-333333333333',
          },
          async (command) => {
            expect(command.input).toContain('"action":"cleanup"')
            contacted.push(command.program)
            return { code: 0, stdout: 'TED_LAB_RESULT={"processStopped":true}\n', stderr: '' }
          },
          async () => {
            throw new Error('simulated ENOSPC')
          },
        ),
      ).rejects.toThrow(/cleanup.*attempted/)
      expect(contacted).toEqual(['/usr/bin/env', '/usr/bin/ssh'])
    }
  })
  it('never lets report-publication failure prevent cleanup of either deployed host', async () => {
    const directory = await scratch()
    const value = config()
    value.knownHosts = `${directory}/known_hosts`
    value.identityFile = `${directory}/identity`
    value.reportDir = `${directory}/reports`
    await writeFile(value.knownHosts, '')
    await writeFile(value.identityFile, '', { mode: 0o600 })
    const file = `${directory}/config.json`
    await writeFile(file, JSON.stringify(value))
    const seen: string[] = []
    const starts = new Map<string, number>()
    const observations = new Map<string, number>()
    const manifests = new Map<string, string>()
    await expect(
      runLab(
        {
          optIn: true,
          configFile: file,
          root: process.cwd(),
          action: 'acceptance',
          scenarios: ['lab-access'],
        },
        async (command) => {
          if (command.program === '/usr/bin/git') return execute(command)
          const begin = command.input.lastIndexOf('await dispatch(') + 'await dispatch('.length
          const request = JSON.parse(
            command.input.slice(begin, command.input.indexOf('))) } catch', begin)),
          ) as HostRequest & { host: { role: string; machineId: string } }
          const role = request.host.role
          seen.push(`${role}:${request.action}`)
          if (request.action === 'deploy') manifests.set(role, manifestDigest(request.files ?? []))
          if (request.action === 'start') starts.set(role, (starts.get(role) ?? 0) + 1)
          if (request.action === 'observe')
            observations.set(role, (observations.get(role) ?? 0) + 1)
          const result = {
            machineId: request.host.machineId,
            contentHash: manifestDigest(request.files ?? []),
            artifacts: [],
            pid: starts.get(role) ?? 0,
            token: `${role}-${starts.get(role)}`,
            starts: starts.get(role),
            sequence: observations.get(role),
          }
          if (request.action === 'verify') result.contentHash = manifests.get(role) ?? ''
          return { code: 0, stdout: `TED_LAB_RESULT=${JSON.stringify(result)}\n`, stderr: '' }
        },
        async (destination, report) => {
          if (
            report.scenarios.some((step) => step.id === 'executor:start' && step.result === 'pass')
          )
            throw new Error('simulated ENOSPC')
          await publishReport(destination, report)
        },
      ),
    ).rejects.toThrow('owned acceptance cleanup was attempted independently')
    expect(seen).toContain('executor:cleanup')
    expect(seen).toContain('controller:cleanup')
  })

  it('bootstrap refuses an existing archive symlink without changing its outside target', async () => {
    const directory = await scratch()
    const root = `${directory}/ted-validation-lab`
    await mkdir(`${root}/runtime`, { recursive: true })
    await writeFile(`${root}/.ted-lab-owner`, 'fixture-owner\n')
    await writeFile(`${root}/runtime/.owner`, 'fixture-owner\n')
    const outside = `${directory}/outside`
    await writeFile(outside, 'keep outside')
    await symlink(outside, `${root}/runtime/node.tar.gz`)
    const helpers = await readFile(
      new URL('./execution-lab/bootstrap-paths.sh', import.meta.url),
      'utf8',
    )
    const exec = promisify(execFile)
    await expect(
      exec('/bin/sh', ['-c', `${helpers}\nprepare_runtime ${quote(root)} fixture-owner`]),
    ).rejects.toThrow()
    expect(await readFile(outside, 'utf8')).toBe('keep outside')
  })

  it('bootstrap uses an exclusive owned staging directory and refuses linked runtime ancestors', async () => {
    const directory = await scratch()
    const root = `${directory}/ted-validation-lab`
    await mkdir(root)
    await writeFile(`${root}/.ted-lab-owner`, 'fixture-owner\n')
    const helpers = await readFile(
      new URL('./execution-lab/bootstrap-paths.sh', import.meta.url),
      'utf8',
    )
    const exec = promisify(execFile)
    const stage = (
      await exec('/bin/sh', ['-c', `${helpers}\nprepare_runtime ${quote(root)} fixture-owner`])
    ).stdout.trim()
    expect(stage).toMatch(new RegExp(`^${root}/\\.runtime-[a-zA-Z0-9]{8}$`))
    expect(await readFile(`${stage}/.owner`, 'utf8')).toBe('fixture-owner\n')
    await mkdir(`${directory}/outside`)
    await mkdir(`${root}/runtime`)
    await writeFile(`${root}/runtime/.owner`, 'fixture-owner\n')
    await symlink(`${directory}/outside`, `${root}/runtime/node`)
    await expect(
      exec('/bin/sh', ['-c', `${helpers}\nprepare_runtime ${quote(root)} fixture-owner`]),
    ).rejects.toThrow()
  })
  it('requires explicit distinct hosts, dedicated roots and pinned machine identities', () => {
    expect(parseConfig(config()).hosts).toHaveLength(2)
    for (const mutate of [
      (value: ReturnType<typeof config>) => {
        value.hosts.pop()
      },
      (value: ReturnType<typeof config>) => {
        if (value.hosts[1] && value.hosts[0]) value.hosts[1].machineId = value.hosts[0].machineId
      },
      (value: ReturnType<typeof config>) => {
        if (value.hosts[1]) value.hosts[1].root = '/Users/executor/.ted'
      },
      (value: ReturnType<typeof config>) => {
        if (value.hosts[1]) value.hosts[1].address = 'host; touch /tmp/unowned'
      },
      (value: ReturnType<typeof config>) => {
        value.reportDir = '/Users/controller/ted-validation-lab/reports'
      },
      (value: ReturnType<typeof config>) => {
        if (value.hosts[1]) value.hosts[1].port = 0
      },
    ]) {
      const value = config()
      mutate(value)
      expect(() => parseConfig(value)).toThrow()
    }
  })

  it('disables implicit SSH config, trust updates, forwarding and interactive authentication', () => {
    const value = parseConfig(config())
    const args = sshArgs(value, value.hosts[1])
    for (const flag of [
      'BatchMode=yes',
      'StrictHostKeyChecking=yes',
      'UpdateHostKeys=no',
      'ForwardAgent=no',
      'ClearAllForwardings=yes',
      'IdentitiesOnly=yes',
    ])
      expect(args).toContain(flag)
    expect(args.slice(0, 2)).toEqual(['-F', '/dev/null'])
    expect(args.at(-1)).toBe('executor@192.0.2.1')
    expect(quote("has ' quotes")).toBe("'has '\\'' quotes'")
  })

  it('refuses symlink components and configuration inside a disposable checkout', async () => {
    const directory = await scratch()
    await mkdir(path.join(directory, 'actual'))
    await symlink(path.join(directory, 'actual'), path.join(directory, 'alias'))
    await expect(plainPath(path.join(directory, 'alias/config.json'))).rejects.toThrow('symlink')
    await writeFile(path.join(directory, 'config.json'), JSON.stringify(config()))
    await expect(readConfig(path.join(directory, 'config.json'), directory)).rejects.toThrow(
      'outside checkout',
    )
  })

  it('does not read inventory or contact hosts without explicit opt-in', async () => {
    let calls = 0
    await expect(
      runLab(
        {
          optIn: false,
          configFile: '/missing',
          root: '/missing',
          action: 'preflight',
          scenarios: ['lab-access'],
        },
        async () => {
          calls++
          throw new Error('must not execute')
        },
      ),
    ).rejects.toThrow('--opt-in')
    expect(calls).toBe(0)
  })

  it('dry-run reads only the explicit external config and never executes commands', async () => {
    const directory = await scratch()
    const checkout = path.join(directory, 'checkout')
    await mkdir(checkout)
    const value = config()
    value.knownHosts = path.join(directory, 'known_hosts')
    value.identityFile = path.join(directory, 'identity')
    await writeFile(value.knownHosts, '')
    await writeFile(value.identityFile, '', { mode: 0o600 })
    const file = path.join(directory, 'config.json')
    await writeFile(file, JSON.stringify(value))
    const result = await runLab(
      {
        optIn: true,
        configFile: file,
        root: checkout,
        action: 'dry-run',
        scenarios: ['product-pairing'],
      },
      async () => {
        throw new Error('host contact')
      },
    )
    expect(result.code).toBe(0)
    expect(result.plan?.action).toBe('no host contact')
  })

  it('uses stdin for requests and rejects missing, malformed or failed host results', async () => {
    const value = parseConfig(config())
    const request = {
      labId: value.labId,
      host: value.hosts[1],
      action: 'preflight' as const,
      runId: '33333333-3333-3333-3333-333333333333',
    }
    const commands: LabCommand[] = []
    const result = await callHost(value, value.hosts[1], request, async (command) => {
      commands.push(command)
      return { code: 0, stdout: 'TED_LAB_RESULT={"machineId":"actual"}\n', stderr: '' }
    })
    expect(result.machineId).toBe('actual')
    expect(commands[0]?.program).toBe('/usr/bin/ssh')
    expect(commands[0]?.input).toContain(`"runId":${JSON.stringify(request.runId)}`)
    expect(commands[0]?.args.join(' ')).not.toContain(request.runId)
    for (const output of [
      { code: 0, stdout: '', stderr: '' },
      { code: 0, stdout: 'TED_LAB_RESULT=[]', stderr: '' },
      { code: 1, stdout: '', stderr: 'connection lost' },
    ])
      await expect(callHost(value, value.hosts[1], request, async () => output)).rejects.toThrow()
  })

  it('attempts recovery on the second host even if the first host cannot complete cleanup', async () => {
    const directory = await scratch()
    const value = config()
    value.knownHosts = `${directory}/known_hosts`
    value.identityFile = `${directory}/identity`
    value.reportDir = `${directory}/reports`
    await writeFile(value.knownHosts, '')
    await writeFile(value.identityFile, '', { mode: 0o600 })
    const file = `${directory}/config.json`
    await writeFile(file, JSON.stringify(value))
    const seen: string[] = []
    const result = await runLab(
      {
        optIn: true,
        configFile: file,
        root: process.cwd(),
        action: 'cleanup',
        scenarios: ['lab-access'],
        runId: '33333333-3333-3333-3333-333333333333',
      },
      async (command) => {
        const prefix = 'await dispatch('
        const begin = command.input.lastIndexOf(prefix) + prefix.length
        const end = command.input.indexOf('))) } catch', begin)
        const request = JSON.parse(command.input.slice(begin, end)) as {
          action: string
          host: { role: string; machineId: string }
        }
        seen.push(`${request.host.role}:${request.action}`)
        if (request.host.role === 'controller' && request.action === 'cleanup')
          return { code: 1, stdout: '', stderr: 'controller unavailable' }
        return {
          code: 0,
          stdout: `TED_LAB_RESULT=${JSON.stringify({ machineId: request.host.machineId, alreadyAbsent: true })}\n`,
          stderr: '',
        }
      },
    )
    expect(result.code).toBe(1)
    expect(seen).toEqual(['controller:cleanup', 'executor:cleanup'])
  })

  it('bootstraps only the configured hosts using the same pinned SSH control', async () => {
    const commands: LabCommand[] = []
    const value = parseConfig(config())
    await bootstrap(value, async (command) => {
      commands.push(command)
      return { code: 0, stdout: 'ready', stderr: '' }
    })
    expect(commands.map((command) => command.program)).toEqual(['/usr/bin/env', '/usr/bin/ssh'])
    expect(commands[1]?.args).toContain('StrictHostKeyChecking=yes')
    expect(commands[0]?.input).toContain('shasum -a 256')
    expect(commands[0]?.input).toContain('pnpm@10.28.0')
  })
})

describe('candidate content and standalone overrides', () => {
  it('waits through changing exit-state details without using them to authorize another signal', async () => {
    const states = ['owned command', '(exiting)', '']
    await expect(
      waitForProcessExit(
        123,
        3,
        async () => states.shift() ?? '',
        async () => {},
      ),
    ).resolves.toBe(true)
    await expect(
      waitForProcessExit(
        123,
        2,
        async () => 'still running',
        async () => {},
      ),
    ).resolves.toBe(false)
  })
  async function installation() {
    const directory = await scratch()
    const machineId = '11111111-1111-1111-1111-111111111111'
    const request: HostRequest = {
      labId: 'lab-test-v1',
      runId: '33333333-3333-3333-3333-333333333333',
      action: 'deploy',
      host: {
        home: directory,
        root: `${directory}/ted-validation-lab`,
        machineId,
        node: process.execPath,
        pnpm: '/unused',
      },
      files: [
        {
          name: 'candidate.txt',
          content: Buffer.from('candidate').toString('base64'),
          mode: 0o644,
          sha256: digest('candidate'),
        },
      ],
      candidate: {
        revision: 'a'.repeat(40),
        contentHash: 'b'.repeat(40),
        dirtyPatchIdentity: null,
      },
    }
    const identity = async () => ({
      machineId,
      hostname: 'fixture-only',
      username: 'fixture-only',
      uid: process.getuid?.(),
      arch: process.arch,
      node: process.version,
      home: directory,
    })
    return { directory, request, identity, run: `${request.host.root}/runs/${request.runId}` }
  }

  it('verifies deployed bytes and modes and detects later tampering', async () => {
    const fixture = await installation()
    const result = await dispatch(fixture.request, fixture.identity)
    expect(result).toMatchObject({
      files: 1,
      contentHash: manifestDigest(fixture.request.files ?? []),
    })
    await expect(
      dispatch({ ...fixture.request, action: 'verify' }, fixture.identity),
    ).resolves.toMatchObject({ files: 1 })
    await writeFile(`${fixture.run}/source/candidate.txt`, 'changed')
    await expect(
      dispatch({ ...fixture.request, action: 'verify' }, fixture.identity),
    ).rejects.toThrow('candidate mismatch')
  })

  it('refuses an unowned root and a replacement run symlink without touching siblings', async () => {
    const fixture = await installation()
    await mkdir(fixture.request.host.root)
    await writeFile(`${fixture.request.host.root}/personal.txt`, 'keep')
    await expect(dispatch(fixture.request, fixture.identity)).rejects.toThrow()
    expect(await readFile(`${fixture.request.host.root}/personal.txt`, 'utf8')).toBe('keep')
    await rm(fixture.request.host.root, { recursive: true })
    await dispatch(fixture.request, fixture.identity)
    await mkdir(`${fixture.directory}/sibling`)
    await writeFile(`${fixture.directory}/sibling/keep`, 'keep')
    await rm(fixture.run, { recursive: true })
    await symlink(`${fixture.directory}/sibling`, fixture.run)
    await expect(
      dispatch({ ...fixture.request, action: 'cleanup' }, fixture.identity),
    ).rejects.toThrow('plain path')
    expect(await readFile(`${fixture.directory}/sibling/keep`, 'utf8')).toBe('keep')
  })

  it('cleans only its owned run and preserves the root, runtime and sibling run', async () => {
    const fixture = await installation()
    await dispatch(fixture.request, fixture.identity)
    await mkdir(`${fixture.request.host.root}/runtime`)
    await writeFile(`${fixture.request.host.root}/runtime/keep`, 'runtime')
    await mkdir(`${fixture.request.host.root}/runs/sibling`)
    await writeFile(`${fixture.request.host.root}/runs/sibling/keep`, 'sibling')
    await expect(
      dispatch({ ...fixture.request, action: 'cleanup' }, fixture.identity),
    ).resolves.toMatchObject({
      removed: fixture.request.runId,
      processStopped: true,
      rootPreserved: true,
    })
    await expect(access(fixture.run)).rejects.toThrow()
    await expect(
      dispatch({ ...fixture.request, action: 'cleanup' }, fixture.identity),
    ).resolves.toMatchObject({ alreadyAbsent: true, processStopped: true })
    expect(await readFile(`${fixture.request.host.root}/runtime/keep`, 'utf8')).toBe('runtime')
    expect(await readFile(`${fixture.request.host.root}/runs/sibling/keep`, 'utf8')).toBe('sibling')
  })

  it('observes progress through relay disconnect, rejects an unowned PID and restarts its stub', async () => {
    const fixture = await installation()
    await dispatch(fixture.request, fixture.identity)
    const act = (action: HostRequest['action']) =>
      dispatch({ ...fixture.request, action }, fixture.identity)
    try {
      await act('start')
      const first = await act('observe')
      expect(await act('connect')).toMatchObject({ relayTargetConfirmed: true })
      await act('disconnect')
      const continued = await act('observe')
      expect(continued).toMatchObject({
        pid: 'pid' in first ? first.pid : undefined,
        token: 'token' in first ? first.token : undefined,
        starts: 1,
      })
      if (!('sequence' in first) || !('sequence' in continued)) throw new Error('missing heartbeat')
      expect(continued.sequence).toBeGreaterThan(first.sequence)
      const receiptFile = `${fixture.run}/service.json`
      const receipt = await readFile(receiptFile, 'utf8')
      await writeFile(
        receiptFile,
        JSON.stringify({ ...JSON.parse(receipt), pid: process.pid, identity: 'unowned' }),
      )
      await expect(act('stop')).rejects.toThrow('ownership changed')
      await writeFile(receiptFile, receipt)
      await act('restart')
      const restarted = await act('observe')
      expect(restarted).toMatchObject({ starts: 2 })
      if (!('token' in first) || !('token' in restarted)) throw new Error('missing generation')
      expect(restarted.token).not.toBe(first.token)
    } finally {
      await act('disconnect')
      await act('stop')
    }
  })
  it('matches only the exact run/home and UID before recovering orphaned processes', () => {
    const run = '33333333-3333-3333-3333-333333333333'
    const home = '/Users/executor/ted-validation-lab/runs/example/ted-home'
    const listing = `501 Tue Nov 11 10:00:00 2026 node service TED_LAB_RUN=${run} TED_HOME=${home}`
    expect(markedListing(listing, 501, run, home)).toBe(true)
    expect(markedListing(listing, 502, run, home)).toBe(false)
    expect(markedListing(listing, 501, `${run}x`, home)).toBe(false)
    expect(markedListing(listing, 501, run, `${home}-sibling`)).toBe(false)
    expect(markedListing(`${listing}-sibling`, 501, run, home)).toBe(false)
    const root = path.dirname(home)
    const worker = `501 Tue Nov 11 10:00:00 2026 node ${root}/source/packages/daemon/src/execution/main.ts TED_LAB_RUN=${run} TED_EXECUTION_HOME=${root}/execution-worker`
    expect(markedListing(worker, 501, run, home)).toBe(true)
    expect(markedListing(worker.replace('main.ts ', 'main.ts.bak '), 501, run, home)).toBe(false)
    expect(
      markedListing(
        worker.replace('/execution-worker', '/execution-worker-sibling'),
        501,
        run,
        home,
      ),
    ).toBe(false)
    expect(markedListing(worker, 502, run, home)).toBe(false)
    const controller = `501 Tue Nov 11 10:00:00 2026 node ${root}/source/packages/daemon/test/fixtures/execution-machine.ts TED_LAB_RUN=${run} TED_HOME=${root}/ted-execution-pairing/home`
    expect(markedListing(controller, 501, run, home)).toBe(true)
    expect(
      markedListing(
        controller.replace('/ted-execution-pairing/home', '/ted-execution-pairing/home-sibling'),
        501,
        run,
        home,
      ),
    ).toBe(false)
  })
  it('rejects traversal, personal environment, credentials and special content paths', () => {
    for (const name of [
      '../outside',
      '/absolute',
      'a/../b',
      '.git/config',
      '.env',
      'x/.env.local',
      'secrets/token',
      'id_ed25519',
      'node_modules/x',
      'x\\y',
    ])
      expect(() => contentName(name)).toThrow()
    expect(contentName('packages/app/src/main.ts')).toBe('packages/app/src/main.ts')
  })

  it('deploys committed bytes with executable modes and refuses a changed candidate', async () => {
    const directory = await scratch()
    const bytes = Buffer.from('candidate\n')
    await writeFile(path.join(directory, 'candidate.ts'), bytes)
    const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
    const enumerate = async () => ({
      code: 0,
      stdout: `100644 blob ${blob}\tcandidate.ts\0`,
      stderr: '',
    })
    const files = await candidateFiles(directory, enumerate)
    expect(files[0]).toEqual({
      name: 'candidate.ts',
      mode: 0o644,
      sha256: digest(bytes),
      content: bytes.toString('base64'),
    })
    const first = files[0]
    if (!first) throw new Error('missing candidate')
    expect(manifestDigest(files)).not.toBe(manifestDigest([{ ...first, mode: 0o755 }]))
    await writeFile(path.join(directory, 'candidate.ts'), 'changed')
    await expect(candidateFiles(directory, enumerate)).rejects.toThrow('commit candidate')
  })

  it('refuses candidate symlinks instead of copying their targets', async () => {
    const directory = await scratch()
    await writeFile(path.join(directory, 'private'), 'private')
    await symlink(path.join(directory, 'private'), path.join(directory, 'link'))
    await expect(
      candidateFiles(directory, async () => ({
        code: 0,
        stdout: `120000 blob ${'a'.repeat(40)}\tlink\0`,
        stderr: '',
      })),
    ).rejects.toThrow('ordinary tracked files')
  })

  it('resolves all stub paths on the launch host without inheriting credentials or Run tokens', async () => {
    const host = parseConfig(config()).hosts[1]
    const env = serviceEnvironment(
      host,
      `${host.root}/runs/example`,
      `${host.root}/runs/example/source`,
    )
    expect(env.TED_CLAUDE_BIN).toBe(
      `${host.root}/runs/example/source/packages/daemon/test/fixtures/stub-claude.ts`,
    )
    expect(env.TED_HOME).toBe(`${host.root}/runs/example/ted-home`)
    expect(env.TED_LINEAR_API).toBe('http://127.0.0.1:9/graphql')
    for (const name of [
      'TED_RUN_TOKEN',
      'TED_RUN_CAPABILITY',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'GH_TOKEN',
      'SSH_AUTH_SOCK',
    ])
      expect(env[name]).toBeUndefined()
    const vitest = await readFile(new URL('../vitest.config.ts', import.meta.url), 'utf8')
    for (const name of [
      'TED_GH_BIN',
      'TED_XCRUN_BIN',
      'TED_OPEN_BIN',
      'TED_LOGIN_SHELL',
      'TED_FREE_BYTES_FILE',
      'TED_LOAD_FILE',
      'TED_ONLINE_FILE',
      'TED_KEYRING_MODULE',
      'TED_LINEAR_API',
      'TED_STAY_AWAKE',
      'TED_LOW_PRIORITY',
      'TED_SKIP_FIRST_LAUNCH',
      'TED_TIME_MACHINE',
      'TED_APP_TOKEN',
      'TED_EDITOR_APP_DIRS',
    ]) {
      expect(vitest).toContain(name)
      expect(env[name]).toBeDefined()
    }
  })
})
