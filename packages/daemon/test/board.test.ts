import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DaemonClient, DaemonRequestError, readDaemonInfo, tedPaths } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
import {
  commitToOrigin,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  rawRequest,
  stubClaudePath,
  stubCodexPath,
} from './helpers.ts'

let home: string
let cleanup: () => Promise<void>
let scratch: string
let origin: string
let daemon: RunningDaemon | undefined

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-origin-'))
  origin = await makeOriginRepo(scratch)
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

async function start(): Promise<DaemonClient> {
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    codexBin: stubCodexPath,
  })
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('no daemon.json')
  return new DaemonClient(info)
}

describe('a Factory’s Board stages', () => {
  test('with the built-in Workflow, every Stage is on and Design and Review are Gated', async () => {
    const client = await start()
    const factory = await client.addFactory({ repo: origin, key: 'NB' })

    expect(await client.factoryBoard(factory.id)).toEqual({
      stages: [
        { id: 'backlog', enabled: true, gate: false },
        { id: 'intake', enabled: true, gate: false },
        { id: 'clarify', enabled: true, gate: false },
        { id: 'design', enabled: true, gate: true },
        { id: 'work', enabled: true, gate: false },
        { id: 'validate', enabled: true, gate: false },
        { id: 'review', enabled: true, gate: true },
        { id: 'merge', enabled: true, gate: false },
        { id: 'done', enabled: true, gate: false },
      ],
    })
  })

  test('follow the Factory’s order, and list a Stage turned off there', async () => {
    await commitToOrigin(scratch, {
      '.ted/workflow.yaml':
        'version: 1\norder: [intake, design, work]\nstages:\n  design: { enabled: false }\n  work: { gate: true }\n',
    })
    const client = await start()
    const factory = await client.addFactory({ repo: origin, key: 'NB' })

    expect((await client.factoryBoard(factory.id)).stages).toEqual([
      { id: 'backlog', enabled: true, gate: false },
      { id: 'intake', enabled: true, gate: false },
      { id: 'design', enabled: false, gate: true },
      { id: 'work', enabled: true, gate: true },
      { id: 'done', enabled: true, gate: false },
    ])
  })

  test('an unknown Factory is a 404, and Runs can’t read the Board', async () => {
    const client = await start()
    const factory = await client.addFactory({ repo: origin, key: 'NB' })
    const error = await client.factoryBoard('nope').catch((e: unknown) => e)
    expect(error instanceof DaemonRequestError && error.status).toBe(404)

    const runToken = (await loadRunTokens(tedPaths(home).runTokenKey)).issue('run-1')
    const asRun = await rawRequest(daemon?.port ?? 0, {
      method: 'GET',
      path: `/factories/${factory.id}/board`,
      headers: { authorization: `Bearer ${runToken}` },
    })
    expect(asRun.status).toBe(403)
  })
})
