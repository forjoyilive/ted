import { copyFile, lstat, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import type { ElectronApplication } from 'playwright'
import { TestRunner } from 'vitest'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const capturesDir = path.join(root, 'node_modules', '.cache', 'ted-test-captures')

const keptRuns = 10
const capturesPerRun = 30
const maxFileBytes = 5 * 1024 * 1024
const maxCaptureBytes = 25 * 1024 * 1024

let captured = 0

function within<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([work, sleep(ms).then(() => undefined)]).catch(() => undefined)
}

async function copyTree(from: string, to: string, budget: { left: number }): Promise<string[]> {
  const skipped: string[] = []
  for (const entry of await readdir(from, { withFileTypes: true }).catch(() => [])) {
    const source = path.join(from, entry.name)
    const target = path.join(to, entry.name)
    if (entry.isDirectory()) {
      skipped.push(...(await copyTree(source, target, budget)))
    } else if (entry.isFile()) {
      const { size } = await lstat(source)
      if (size > maxFileBytes || size > budget.left) {
        skipped.push(source)
        continue
      }
      budget.left -= size
      await mkdir(to, { recursive: true })
      await copyFile(source, target)
    }
  }
  return skipped
}

async function pruneRuns(current: string): Promise<void> {
  const runs = await Promise.all(
    (await readdir(capturesDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name !== current)
      .map(async (entry) => ({
        name: entry.name,
        at: (await stat(path.join(capturesDir, entry.name))).mtimeMs,
      })),
  )
  runs.sort((a, b) => b.at - a.at)
  for (const run of runs.slice(keptRuns - 1)) {
    await rm(path.join(capturesDir, run.name), { recursive: true, force: true })
  }
}

async function capture(
  app: ElectronApplication,
  test: { name: string; file: string; errors: string[] },
): Promise<string | undefined> {
  const run = (process.env.TED_TEST_RUN ?? 'no-run').replace(/[^\w-]/g, '_')
  const runDir = path.join(capturesDir, run)
  await mkdir(runDir, { recursive: true })
  await pruneRuns(run)
  const taken = (await readdir(runDir)).length
  if (taken >= capturesPerRun) return undefined
  const slug = test.name
    .replace(/[^\w]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
  captured++
  const dir = path.join(runDir, `${path.basename(test.file)}-${slug}-${process.pid}-${captured}`)
  await mkdir(dir)

  const notes = [`${test.file} > ${test.name}`, '', ...test.errors]
  const window = app.windows()[0]
  if (window) {
    await within(window.screenshot({ path: path.join(dir, 'window.png') }), 8000)
    const text = await within(window.locator('body').ariaSnapshot({ timeout: 5000 }), 6000)
    if (text !== undefined) await writeFile(path.join(dir, 'window.txt'), text)
  } else {
    notes.push('', 'The app had no window.')
  }
  const home = await within(
    app.evaluate(() => process.env.TED_HOME),
    5000,
  )
  if (home) {
    const budget = { left: maxCaptureBytes }
    const skipped = [
      ...(await copyTree(path.join(home, 'logs'), path.join(dir, 'logs'), budget)),
      ...(await copyTree(path.join(home, 'runs'), path.join(dir, 'runs'), budget)),
    ]
    if (skipped.length > 0) notes.push('', 'Not copied (too large):', ...skipped)
  } else {
    notes.push('', 'The app did not report its TED_HOME.')
  }
  await writeFile(path.join(dir, 'failure.txt'), `${notes.join('\n')}\n`)
  return dir
}

export async function captureFailure(app: ElectronApplication): Promise<void> {
  try {
    const test = TestRunner.getCurrentTest()
    if (test?.result?.state !== 'fail') return
    const dir = await within(
      capture(app, {
        name: test.name,
        file: path.relative(root, test.file.filepath),
        errors: (test.result.errors ?? []).map((error) => error.stack ?? error.message),
      }),
      30_000,
    )
    if (dir) console.warn(`Failure capture for “${test.name}”: ${dir}`)
  } catch {}
}
