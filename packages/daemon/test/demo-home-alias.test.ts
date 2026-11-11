import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, test } from 'vitest'

const exec = promisify(execFile)
const moduleUrl = new URL('../src/dev/home.ts', import.meta.url).href
let userHome: string
async function check(home: string): Promise<{ allowed?: boolean; error?: string }> {
  const { stdout } = await exec(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { checkDemoHome } from ${JSON.stringify(moduleUrl)}
       const result = await checkDemoHome(process.argv[1]).then(
         () => ({ allowed: true }), error => ({ error: error.message }))
       console.log(JSON.stringify(result))`,
      home,
    ],
    { env: { ...process.env, HOME: userHome, USERPROFILE: userHome } },
  )
  return JSON.parse(stdout)
}

let folder: string
beforeEach(async () => {
  const parent = path.resolve('node_modules/.cache/demo-home-alias-tests')
  await mkdir(parent, { recursive: true })
  folder = await mkdtemp(path.join(parent, 'demo-alias-'))
  userHome = path.join(folder, 'user')
  for (const name of ['.ted', '.ted-dev'])
    await mkdir(path.join(userHome, name), { recursive: true })
})
afterEach(async () => {
  await rm(folder, { recursive: true, force: true })
})

test.for([
  { name: '.ted', alias: '.TED' },
  { name: '.ted-dev', alias: '.TeD-DeV' },
])(
  'rejects empty and missing homes through a case alias of $name',
  async ({ name, alias }, context) => {
    const protectedHome = path.join(userHome, name)
    const aliased = path.join(userHome, alias)
    if ((await realpath(aliased).catch(() => undefined)) !== (await realpath(protectedHome)))
      context.skip()
    for (const home of [aliased, path.join(aliased, 'missing-demo')])
      expect(await check(home)).toEqual({ error: expect.stringContaining('separate demo home') })
    expect(await readdir(protectedHome)).toEqual([])
  },
)

test('reserves protected home names before they exist, including alternate casing', async () => {
  await rm(path.join(userHome, '.ted-dev'), { recursive: true })
  expect(await check(path.join(userHome, '.TED-DEV'))).toEqual({
    error: expect.stringContaining('separate demo home'),
  })
  expect(await check(path.join(userHome, '.TED-DEV', 'demo'))).toEqual({
    error: expect.stringContaining('separate demo home'),
  })
})

test('still accepts separate missing and empty demo homes', async () => {
  await mkdir(path.join(userHome, '.ted-dev-demo'))
  expect(await check(path.join(userHome, '.ted-dev-demo'))).toEqual({ allowed: true })
  expect(await check(path.join(folder, 'separate-demo'))).toEqual({ allowed: true })
})
