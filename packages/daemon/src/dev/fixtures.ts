import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { gitEnv } from '../command-env.ts'
import { demoEnvironment } from './home.ts'

const exec = promisify(execFile)
export async function demoGit(home: string, cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd,
    env: {
      ...gitEnv(demoEnvironment(home)),
      GIT_AUTHOR_DATE: '2025-01-01T12:00:00Z',
      GIT_COMMITTER_DATE: '2025-01-01T12:00:00Z',
    },
  })
  return stdout.trim()
}

export const workflow = `version: 1
lead: { agent: claude }
reviewer: { agent: claude }
planner: { agent: claude }
order: [intake, clarify, design, work, validate, review, merge]
stages:
  clarify: { depth: few }
  design: { gate: true }
  validate:
    checks:
      - { name: Smoke, run: 'node check.js' }
  review: { gate: true, based_on: abcdef0 }
  merge: { gate: true }
repos:
  - name: web
    remote: https://github.com/demo/garden
    apps:
      - { name: Web, run: 'node server.js', port: 4310, url: 'http://localhost:4310' }
      - name: iPhone
        kind: ios-simulator
        run: 'true'
        device: iPhone 17
  - { name: api, remote: 'https://github.com/demo/garden-api' }
`

export async function prepareDemoBinaries(home: string): Promise<void> {
  const bin = path.join(home, 'bin')
  await mkdir(bin, { recursive: true })
  const executable = async (name: string, source: string) => {
    const temporary = path.join(bin, `${name}-${randomUUID()}.mjs`)
    await writeFile(temporary, source, { flag: 'wx', mode: 0o700 })
    await rename(temporary, path.join(bin, `${name}.mjs`))
  }
  for (const stub of ['gh', 'claude', 'codex']) {
    const fixture = new URL(`../../test/fixtures/stub-${stub}.ts`, import.meta.url)
    await executable(
      `stub-${stub}`,
      `#!/usr/bin/env node
import { enableCompileCache } from 'node:module'
enableCompileCache(${JSON.stringify(path.join(home, 'module-cache'))})
await import(${JSON.stringify(fixture.href)})
`,
    )
  }
}

export async function makeDemoOrigins(home: string): Promise<void> {
  await writeFile(
    path.join(home, 'gitconfig'),
    '[user]\n name = Ted Demo\n email = demo@example.invalid\n[core]\n hooksPath = /dev/null\n',
  )
  for (const name of ['garden', 'garden-api', 'journal']) {
    const cwd = path.join(home, 'fixture-repos', name)
    await mkdir(path.join(cwd, '.ted', 'stages'), { recursive: true })
    await demoGit(home, cwd, 'init', '-b', 'main')
    const layer = name === 'garden' ? workflow : workflow.slice(0, workflow.indexOf('repos:'))
    await writeFile(path.join(cwd, '.ted', 'workflow.yaml'), layer)
    if (name === 'garden')
      await writeFile(
        path.join(cwd, '.ted', 'stages', 'review.md'),
        '# Review\n\nCheck the note editor and its keyboard behavior.\n',
      )
    await writeFile(
      path.join(cwd, 'README.md'),
      `# ${name === 'journal' ? 'Field Notes' : 'Garden'}\n\nSmall tools for a calmer day.\n`,
    )
    await mkdir(path.join(cwd, '.github', 'workflows'), { recursive: true })
    await writeFile(
      path.join(cwd, '.github', 'workflows', 'ci.yml'),
      'name: Build\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps: [{ run: node check.js }]\n',
    )
    await writeFile(
      path.join(cwd, 'check.js'),
      "import { writeFileSync } from 'node:fs'\nwriteFileSync('stub-check-passed', 'ok')\nconsole.log('All smoke checks passed')\n",
    )
    await writeFile(path.join(cwd, '.gitignore'), 'stub-check-passed\n')
    await writeFile(
      path.join(cwd, 'server.js'),
      "import http from 'node:http'\nhttp.createServer((_req, res) => res.end('Garden demo')).listen(Number(process.env.PORT || 4310), '127.0.0.1')\n",
    )
    await demoGit(home, cwd, 'add', '.')
    await demoGit(home, cwd, 'commit', '-m', 'Start the demo project')
    await mkdir(path.join(home, 'origins'), { recursive: true })
    await demoGit(home, cwd, 'clone', '--bare', cwd, path.join(home, 'origins', `${name}.git`))
  }
  const runtime = 'com.apple.CoreSimulator.SimRuntime.iOS-26-0'
  await writeFile(
    path.join(home, 'xcrun.json'),
    JSON.stringify({
      xcode: true,
      runtimes: [{ identifier: runtime, name: 'iOS 26.0', platform: 'iOS', isAvailable: true }],
      deviceTypes: [
        { name: 'iPhone 17', identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17' },
      ],
      devices: {
        [runtime]: [
          {
            udid: 'DEMO-BASE-IPHONE',
            name: 'iPhone 17',
            state: 'Shutdown',
            isAvailable: true,
            deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17',
          },
        ],
      },
    }),
  )
  const paths = Object.fromEntries(
    ['garden', 'garden-api', 'journal'].flatMap((name) => [
      [
        `repos/demo/${name}`,
        {
          body: { full_name: `demo/${name}`, default_branch: 'main', permissions: { push: true } },
        },
      ],
      [`repos/demo/${name}/commits?per_page=1`, { body: [] }],
    ]),
  )
  await writeFile(
    path.join(home, 'gh.json'),
    JSON.stringify({
      paths,
      pr: { numbered: true },
      merge: {
        origins: Object.fromEntries(
          ['garden', 'garden-api', 'journal'].map((name) => [
            `demo/${name}`,
            path.join(home, 'origins', `${name}.git`),
          ]),
        ),
        allowed: ['squash'],
        checks: [{ name: 'Build', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      },
    }),
  )
}

export async function commitDemoTask(
  home: string,
  task: import('@ted/protocol').Task,
): Promise<void> {
  for (const repo of task.repos) {
    const common = await demoGit(home, repo.worktree, 'rev-parse', '--git-common-dir')
    const gitDir = path.resolve(repo.worktree, common)
    const index = path.join(home, 'inputs', `${task.displayId}-${repo.name}.index`)
    const run = async (args: string[], input?: string) => {
      const child = exec('git', ['--git-dir', gitDir, '-c', 'core.hooksPath=/dev/null', ...args], {
        cwd: home,
        env: {
          ...gitEnv(demoEnvironment(home)),
          GIT_INDEX_FILE: index,
          GIT_AUTHOR_DATE: '2025-01-02T12:00:00Z',
          GIT_COMMITTER_DATE: '2025-01-02T12:00:00Z',
        },
      })
      child.child.stdin?.end(input)
      return (await child).stdout.trim()
    }
    const parent = await run(['rev-parse', repo.branch])
    await run(['read-tree', parent])
    const text = `# Garden\n\n${task.title}.\n`
    const blob = await run(['hash-object', '-w', '--stdin'], text)
    await run(['update-index', '--add', '--cacheinfo', `100644,${blob},README.md`])
    const tree = await run(['write-tree'])
    const commit = await run(['commit-tree', tree, '-p', parent, '-m', task.title])
    await run(['update-ref', `refs/heads/${repo.branch}`, commit, parent])
    await writeFile(path.join(repo.worktree, 'README.md'), text)
  }
}
