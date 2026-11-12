import { spawn } from 'node:child_process'
import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  DaemonClient,
  enrollmentLifetimeMs,
  executionHello,
  readDaemonInfo,
  tedPaths,
} from '@ted/protocol'
import { expect, test } from 'vitest'
import { productWorker } from '../../../scripts/execution-lab/product-worker.ts'
import { createEnvironment, executionEnvironment } from '../src/command-env.ts'
import { privateDirectory, readPrivate } from '../src/execution/files.ts'
import { createExecutionReadiness } from '../src/execution/readiness.ts'
import { startExecutionService } from '../src/execution/service.ts'
import { executionRequest } from '../src/execution/transport.ts'
import { loadRunTokens } from '../src/run-token.ts'
import { fixtureEnvironment, waitUntil } from './helpers.ts'
import { createExecutionFixture } from './support/execution-fixture.ts'
import { observe } from './support/execution-observations.ts'
import {
  executionWorkerFixture,
  pendingPairing,
  preparePairingController,
} from './support/execution-pairing.ts'

test('pairing across isolated processes refuses untrusted peers and preserves approved trust through restart and revocation', async () => {
  const fixture = await createExecutionFixture()
  const worker = executionWorkerFixture(path.join(fixture.root, 'execution-worker'), 'c'.repeat(64))
  try {
    const controller = await fixture.machine('controller')
    const { offer, factoryId } = await preparePairingController(controller)
    expect((await worker.start()).owner).toBe('c'.repeat(64))
    const attached = await startExecutionService(
      worker.home,
      fixtureEnvironment(worker.home),
      'd'.repeat(64),
    )
    expect(attached).toMatchObject({ started: false, owner: 'c'.repeat(64) })
    await worker.request('pair', {
      details: JSON.stringify({ ...offer, controllerPin: '0'.repeat(64) }),
      capacity: 2,
    })
    expect((await worker.state('refused')).message).toContain('identity')
    expect((await controller.client.executionMachines()).pending).toEqual([])
    await worker.request('stop')
    await expect(
      worker.request('pair', { details: JSON.stringify({ ...offer, protocol: 999 }), capacity: 2 }),
    ).rejects.toThrow()
    await expect(executionRequest(offer, '/execution/approve', {})).rejects.toThrow()
    await expect(
      executionRequest(offer, '/heartbeat', { ...executionHello(), grantId: 'unapproved' }),
    ).rejects.toThrow()
    const attempted = {
      ...executionHello(),
      secret: offer.secret,
      csr: await readPrivate(worker.home, 'worker.csr'),
      name: 'Worker',
      readiness: (await worker.request('status')).readiness,
    }
    for (const incompatible of [{ protocol: 999 }, { edition: 'release' }, { capabilities: [] }]) {
      await expect(
        executionRequest(offer, '/enroll', { ...attempted, ...incompatible }),
      ).rejects.toThrow()
    }
    expect(
      await productWorker(fixture.root, fixtureEnvironment(worker.home), {
        operation: 'attempt',
        pair: { details: JSON.stringify(offer), capacity: 2 },
      }),
    ).toEqual({ refused: true, transport: 'pinned-tls', protocol: 999 })
    expect((await controller.client.executionMachines()).pending).toEqual([])
    await observe('pairing-peer-refusals', {
      wrongIdentity: 'refused before enrollment',
      wrongProtocol: 'refused',
      executionForwarding: 'absent',
    })

    await controller.control({ executionClockOffsetMs: enrollmentLifetimeMs + 1 })
    await worker.request('pair', { details: JSON.stringify(offer), capacity: 2 })
    await worker.state('refused')
    expect((await controller.client.executionMachines()).pending).toEqual([])
    await controller.control({ executionClockOffsetMs: 0 })
    const fresh = await controller.client.createExecutionEnrollment()
    await worker.request('stop')
    await worker.request('pair', { details: JSON.stringify(fresh), capacity: 2 })
    const pending = await pendingPairing(controller)
    expect((await worker.state('pending')).publicKey).toBe(pending.publicKey)
    await controller.control({ executionClockOffsetMs: enrollmentLifetimeMs + 1 })
    const scope = (await controller.client.executionMachines()).repos.find(
      (r) => r.factoryId === factoryId,
    )
    if (!scope) throw new Error('No approved repo')
    await expect(
      controller.client.approveExecution({ id: pending.id, scopes: [scope] }),
    ).rejects.toThrow()
    expect((await controller.client.executionMachines()).machines).toEqual([])
    await controller.client.cancelExecutionEnrollment()
    await worker.state('refused')
    await controller.control({ executionClockOffsetMs: 0 })
    await observe('pairing-expiry', {
      expiredEnrollment: 'refused',
      pendingApprovalAfterExpiry: 'refused',
    })

    await worker.request('stop')
    const valid = await controller.client.createExecutionEnrollment()
    await worker.request('pair', { details: JSON.stringify(valid), capacity: 3 })
    const review = await pendingPairing(controller)
    await expect(
      controller.client.approveExecution({
        id: review.id,
        scopes: [{ factoryId, repo: 'other/unapproved' }],
      }),
    ).rejects.toThrow()
    const info = await readDaemonInfo(controller.home)
    if (!info) throw new Error('No daemon identity')
    const fileClient = new DaemonClient(info)
    const tokens = await loadRunTokens(tedPaths(controller.home).runTokenKey)
    const runClient = new DaemonClient(info, tokens.issue('synthetic-unprivileged-run'))
    const machineClient = new DaemonClient(info, 'machine-certificate-is-not-an-app-key')
    for (const client of [fileClient, runClient, machineClient]) {
      await expect(client.approveExecution({ id: review.id, scopes: [scope] })).rejects.toThrow()
      await expect(client.createExecutionEnrollment()).rejects.toThrow()
      await expect(client.revokeExecution({ id: review.id })).rejects.toThrow()
    }
    const grant = await controller.client.approveExecution({ id: review.id, scopes: [scope] })
    const connected = await worker.state('connected')
    expect(connected).toMatchObject({
      publicKey: review.publicKey,
      grantId: grant.id,
      readiness: { capacity: 3 },
    })
    const persisted = await readPrivate(worker.home, 'pairing.json')
    const credential = JSON.parse(persisted).credential as { certificate: string }
    await expect(
      new DaemonClient(
        info,
        Buffer.from(credential.certificate).toString('base64'),
      ).approveExecution({
        id: review.id,
        scopes: [scope],
      }),
    ).rejects.toThrow()
    const privateKey = await readPrivate(worker.home, 'worker-key.pem')
    await expect(
      executionRequest(
        valid,
        '/execution/approve',
        { id: review.id, scopes: [scope] },
        { key: privateKey, cert: credential.certificate },
      ),
    ).rejects.toThrow()
    expect(persisted.includes(info.token)).toBe(false)
    const appToken = controller.ready?.appToken
    if (!appToken) throw new Error('No app authorization')
    expect(persisted.includes(appToken)).toBe(false)
    expect(persisted.includes(await readFile(tedPaths(controller.home).runTokenKey, 'utf8'))).toBe(
      false,
    )
    await observe('pairing-human-authority', {
      app: 'approved',
      file: 'refused',
      run: 'refused',
      machine: 'refused',
      workerIdentity: review.publicKey,
      grantId: grant.id,
      scopes: grant.scopes,
    })

    await worker.close()
    await worker.start()
    await worker.request('start')
    expect(await worker.state('connected')).toMatchObject({
      grantId: grant.id,
      publicKey: review.publicKey,
    })
    await controller.kill()
    await controller.start()
    expect(await worker.state('connected')).toMatchObject({ grantId: grant.id })
    await waitUntil(
      async () =>
        (await controller.client.executionMachines()).machines.find(
          (m) => m.id === grant.id && m.connected,
        ),
      'reconnected after controller restart',
    )
    await observe('pairing-restart', {
      sameGrant: true,
      samePublicKey: true,
      controllerRestart: true,
    })

    await controller.client.revokeExecution({ id: grant.id })
    await worker.state('refused')
    expect(
      (await controller.client.executionMachines()).machines.find((m) => m.id === grant.id),
    ).toMatchObject({ connected: false, revokedAt: expect.any(String) })
    const directOffer = await controller.client.createExecutionEnrollment()
    await worker.request('pair', { details: JSON.stringify(directOffer), capacity: 2 })
    const directReview = await pendingPairing(controller)
    const directGrant = await controller.client.approveExecution({
      id: directReview.id,
      scopes: [scope],
    })
    expect(directGrant.id).not.toBe(grant.id)
    expect(await worker.state('connected')).toMatchObject({ grantId: directGrant.id })
    await observe('pairing-direct-repair', {
      restartedWorker: 'paired directly after live revocation without Stop',
      oldGrant: grant.id,
      newGrant: directGrant.id,
      approval: 'fresh app-authorized approval',
    })
    await controller.client.revokeExecution({ id: directGrant.id })
    await worker.state('refused')
    await worker.close()
    await worker.start()
    await worker.request('start')
    await worker.state('refused')
    await controller.kill()
    await controller.start()
    expect(
      (await controller.client.executionMachines()).machines.find((m) => m.id === grant.id)
        ?.revokedAt,
    ).toBeTruthy()
    await expect(
      executionRequest(
        valid,
        '/heartbeat',
        { ...executionHello(), grantId: grant.id, readiness: connected.readiness },
        { key: privateKey, cert: credential.certificate },
      ),
    ).rejects.toThrow()
    await worker.request('stop')
    const again = await controller.client.createExecutionEnrollment()
    await worker.request('pair', { details: JSON.stringify(again), capacity: 2 })
    const newReview = await pendingPairing(controller)
    const newGrant = await controller.client.approveExecution({ id: newReview.id, scopes: [scope] })
    expect(newGrant.id).not.toBe(grant.id)
    await worker.state('connected')
    expect(
      (await controller.client.executionMachines()).machines.find((m) => m.id === grant.id)
        ?.revokedAt,
    ).toBeTruthy()
    await expect(
      executionRequest(
        again,
        '/heartbeat',
        { ...executionHello(), grantId: newGrant.id, readiness: connected.readiness },
        { key: privateKey, cert: credential.certificate },
      ),
    ).rejects.toThrow()
    await controller.client.removeFactory(factoryId, { key: 'PAIR', closePullRequests: false })
    await worker.state('refused')
    const removedGrant = (await controller.client.executionMachines()).machines.find(
      (m) => m.id === newGrant.id,
    )
    expect(removedGrant).toMatchObject({ scopes: [], revokedAt: expect.any(String) })
    expect(await controller.agentStarts()).toBe(0)
    await observe('pairing-revocation', {
      liveTraffic: 'refused',
      restart: 'refused',
      rePairGrant: newGrant.id,
      oldGrant: grant.id,
      oldCertificateForNewGrant: 'refused',
      agentStarts: 0,
    })
  } finally {
    await worker.close()
    await fixture.close()
  }
}, 180_000)

test('CLI Pair replaces a still-valid saved controller after process Stop and requires fresh approval', async () => {
  const fixture = await createExecutionFixture()
  const home = path.join(fixture.root, 'replacement-worker')
  const env = { ...fixtureEnvironment(home), TED_EXECUTION_HOME: home }
  async function cli(operation: string, input = '') {
    const child = spawn(
      process.execPath,
      [path.resolve('packages/cli/src/main.ts'), 'execution', operation],
      {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    const exited = new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`CLI ${operation} failed: ${output}`)),
      )
    })
    child.stdin.end(input)
    await exited
  }
  const worker = executionWorkerFixture(home)
  try {
    const first = await fixture.machine('controller')
    const second = await fixture.machine('controller')
    const original = await preparePairingController(first)
    const replacement = await preparePairingController(second)
    const originalScope = (await first.client.executionMachines()).repos.find(
      (repo) => repo.factoryId === original.factoryId,
    )
    const replacementScope = (await second.client.executionMachines()).repos.find(
      (repo) => repo.factoryId === replacement.factoryId,
    )
    if (!originalScope || !replacementScope) throw new Error('Missing synthetic repo scope')
    await worker.start()
    await worker.request('pair', { details: JSON.stringify(original.offer), capacity: 2 })
    const review = await pendingPairing(first)
    const oldGrant = await first.client.approveExecution({ id: review.id, scopes: [originalScope] })
    await worker.state('connected')
    await cli('stop')
    await cli('pair', JSON.stringify(replacement.offer))
    const pending = await pendingPairing(second)
    expect(await worker.state('pending')).toMatchObject({
      publicKey: review.publicKey,
      controllerPin: replacement.offer.controllerPin,
      scopes: [],
    })
    expect((await worker.request('status')).grantId).toBeUndefined()
    expect(
      (await first.client.executionMachines()).machines.find((m) => m.id === oldGrant.id)
        ?.revokedAt,
    ).toBeUndefined()
    const newGrant = await second.client.approveExecution({
      id: pending.id,
      scopes: [replacementScope],
    })
    expect(newGrant.id).not.toBe(oldGrant.id)
    expect(await worker.state('connected')).toMatchObject({ grantId: newGrant.id })
    await observe('pairing-cli-replacement', {
      oldController: original.offer.controllerPin,
      newController: replacement.offer.controllerPin,
      oldGrant: oldGrant.id,
      newGrant: newGrant.id,
      processStop: 'CLI Stop followed directly by Pair',
      approval: 'fresh app approval required',
    })
  } finally {
    await worker.close()
    await fixture.close()
  }
}, 120_000)

test('execution storage refuses linked homes and child environment excludes broad credentials', async () => {
  const fixture = await createExecutionFixture()
  try {
    const root = await privateDirectory(path.join(fixture.root, 'worker'))
    await symlink(root, path.join(fixture.root, 'linked'))
    await expect(privateDirectory(path.join(fixture.root, 'linked'))).rejects.toThrow('links')
    expect(await realpath(root)).toBe(root)
    const env = executionEnvironment({
      PATH: '/usr/bin',
      HOME: root,
      TED_RUN: 'run',
      TED_RUN_CAPABILITY: 'secret',
      TED_APP_TOKEN: 'secret',
      OPENAI_API_KEY: 'secret',
      SSH_AUTH_SOCK: 'secret',
      TED_TEST_RUN: 'test',
    })
    expect(env).toEqual({ PATH: '/usr/bin', HOME: root, TED_TEST_RUN: 'test' })
    const shell = path.join(root, 'login-shell')
    const bin = path.join(root, 'bin')
    await mkdir(bin)
    await writeFile(
      shell,
      `#!/bin/sh
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export PATH="$script_dir/bin" SHELL=/bin/sh OPENAI_API_KEY=login-secret TED_RUN_CAPABILITY=login-secret
printf '%s' '__TED_LOGIN_ENV__'
/usr/bin/env -0
`,
      { mode: 0o700 },
    )
    await writeFile(
      path.join(bin, 'claude'),
      `#!/bin/sh
test "$#" = 1 && test "$1" = --version || exit 1
test -z "$OPENAI_API_KEY" && test -z "$TED_RUN_CAPABILITY" || exit 2
printf '%s\\n' 'Claude Code 1.2.3'
`,
      { mode: 0o700 },
    )
    await writeFile(path.join(bin, 'codex'), '#!/bin/sh\nexit 1\n', { mode: 0o700 })
    const environment = createEnvironment({
      loginShell: true,
      base: executionEnvironment({
        ...process.env,
        PATH: '/usr/bin:/bin',
        SHELL: shell,
        HOME: root,
      }),
    })
    const discovered = executionEnvironment(await environment.reload())
    expect(discovered.PATH).toBe(bin)
    expect(discovered.OPENAI_API_KEY).toBeUndefined()
    expect(discovered.TED_RUN_CAPABILITY).toBeUndefined()
    const observed = await createExecutionReadiness(root, discovered)(2)
    expect(observed.agents).toMatchObject([
      { name: 'claude', detected: true, version: 'Claude Code 1.2.3', modelAccess: 'unknown' },
      {
        name: 'codex',
        detected: true,
        version: null,
        versionReason: expect.stringContaining('failed'),
      },
    ])
    const missing = await createExecutionReadiness(root, {
      ...discovered,
      PATH: path.join(root, 'absent'),
    })(2)
    expect(missing.agents).toMatchObject([
      { detected: false, version: null, versionReason: 'Executable not detected' },
      { detected: false, version: null, versionReason: 'Executable not detected' },
    ])
    await observe('pairing-shell-readiness', {
      shellPath: 'agent detected outside the app-like minimal PATH',
      credentials: 'filtered before version probes',
      versions: observed.agents.map(({ name, version }) => ({ name, version })),
      missing: 'explicitly unavailable',
    })
  } finally {
    await fixture.close()
  }
})
