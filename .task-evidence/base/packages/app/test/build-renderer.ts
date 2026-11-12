import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const appDir = fileURLToPath(new URL('..', import.meta.url))

async function viteBuild(): Promise<void> {
  await build({ configFile: path.join(appDir, 'vite.config.ts'), logLevel: 'warn' })
}

// Every app test file loads dist/renderer, and a build empties it first, so a
// second build while another file's app is starting makes that app fail with
// ERR_FILE_NOT_FOUND. One file per test run builds; the others wait for it.
export async function buildRenderer(timeoutMs = 180_000): Promise<void> {
  const run = process.env.TED_TEST_RUN
  if (!run) return viteBuild()
  const dir = path.join(tmpdir(), 'ted-renderer-builds', run)
  await mkdir(dir, { recursive: true })
  const result = path.join(dir, 'result')
  const builder = await writeFile(path.join(dir, 'lock'), String(process.pid), { flag: 'wx' }).then(
    () => true,
    () => false,
  )
  if (builder) {
    try {
      await viteBuild()
      await writeFile(result, 'built')
    } catch (error) {
      await writeFile(result, `failed: ${String(error)}`)
      throw error
    }
    return
  }
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const text = await readFile(result, 'utf8').catch(() => undefined)
    if (text === 'built') return
    if (text?.startsWith('failed:')) throw new Error(`another test file’s renderer build ${text}`)
    if (Date.now() > deadline) throw new Error('timed out waiting for the renderer build')
    await sleep(100)
  }
}
