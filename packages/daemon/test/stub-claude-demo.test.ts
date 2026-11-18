import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { expect, test } from 'vitest'
import { stubClaudePath, waitUntil } from './helpers.ts'

test('the demo stub records an interrupted or empty script as failed, outside its conversation', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'ted-stub-demo-'))
  const run = randomUUID()
  const scripts = path.join(home, 'inputs', 'runs', run)
  await mkdir(scripts, { recursive: true })
  const child = spawn(process.execPath, [stubClaudePath], {
    cwd: home,
    env: { ...process.env, TED_DEMO: '1', TED_HOME: home, TED_RUN: run },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const lines: string[] = []
  createInterface({ input: child.stdout }).on('line', (line) => lines.push(line))
  const drop = async (n: number, steps: unknown[]) => {
    const file = path.join(scripts, `${n}.json`)
    await writeFile(`${file}.tmp`, JSON.stringify({ steps }))
    await rename(`${file}.tmp`, file)
  }
  const results = (n: number) =>
    waitUntil(
      () =>
        readFile(path.join(scripts, `${n}.result.json`), 'utf8').then(
          (text) => JSON.parse(text) as { results: { step: string; code: number }[] },
          () => undefined,
        ),
      `results of script ${n}`,
    )
  try {
    await drop(1, [{ waitFor: path.join(home, 'never') }])
    await waitUntil(
      () => lines.some((line) => line.includes('"subtype":"init"')),
      'script 1 to start',
    )
    child.stdin.write(
      `${JSON.stringify({ type: 'control_request', request_id: 'stop', request: { subtype: 'interrupt' } })}\n`,
    )
    expect((await results(1)).results).toEqual([
      expect.objectContaining({ step: 'script', code: 1 }),
    ])
    await drop(2, [])
    expect((await results(2)).results).toEqual([
      expect.objectContaining({ step: 'script', code: 1 }),
    ])
    expect(lines.some((line) => line.includes('"type":"user"'))).toBe(false)
    expect(lines.some((line) => line.includes('stdout'))).toBe(false)
  } finally {
    child.kill()
    await rm(home, { recursive: true, force: true })
  }
}, 60_000)
