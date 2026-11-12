import { readFile, realpath, symlink } from 'node:fs/promises'
import path from 'node:path'
import {
  DaemonClient,
  enrollmentLifetimeMs,
  executionHello,
  readDaemonInfo,
  tedPaths,
} from '@ted/protocol'
import { expect, test } from 'vitest'
import { executionEnvironment } from '../src/command-env.ts'
import { privateDirectory, readPrivate } from '../src/execution/files.ts'
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
  const worker = executionWorkerFixture(path.join(fixture.root, 'worker'), 'c'.repeat(64))
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
  } finally {
    await fixture.close()
  }
})
