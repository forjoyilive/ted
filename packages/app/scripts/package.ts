import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { releaseRepo } from '@ted/protocol'
import { build, type Configuration } from 'electron-builder'
import { appDir, stage } from './stage.ts'

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    mac: { type: 'boolean' },
    linux: { type: 'boolean' },
    dir: { type: 'boolean' },
    x64: { type: 'boolean' },
    arm64: { type: 'boolean' },
  },
})

const env = process.env
const signs = Boolean(env.CSC_LINK || env.CSC_NAME)
const notarizes = Boolean(
  (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) ||
    (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID),
)
if (values.mac && !values.dir && !signs) {
  console.warn('Building an unsigned macOS app: set CSC_LINK and CSC_KEY_PASSWORD to sign it.')
}
if (values.mac && signs && !notarizes) {
  console.warn('Signing without notarizing: set the APPLE_API_KEY variables to notarize.')
}

const electron = JSON.parse(
  readFileSync(path.join(appDir, 'node_modules', 'electron', 'package.json'), 'utf8'),
) as { version: string }
const buildDir = path.join(appDir, 'build')

const config: Configuration = {
  appId: 'design.kriya.ted',
  productName: 'TED',
  copyright: `Copyright © ${new Date().getFullYear()} Kriya Design`,
  electronVersion: electron.version,
  directories: {
    app: path.join(appDir, 'dist', 'stage'),
    output: path.join(appDir, 'dist', 'release'),
    buildResources: buildDir,
  },
  asar: false,
  electronFuses: {
    runAsNode: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableCookieEncryption: true,
  },
  npmRebuild: false,
  nodeGypRebuild: false,
  files: ['**/*'],
  extraResources: [{ from: path.join(buildDir, 'bin'), to: 'bin' }],
  mac: {
    category: 'public.app-category.developer-tools',
    target: ['dmg', 'zip'],
    hardenedRuntime: signs,
    entitlements: path.join(buildDir, 'entitlements.mac.plist'),
    entitlementsInherit: path.join(buildDir, 'entitlements.mac.plist'),
    extraFiles: [{ from: path.join(buildDir, 'mac', 'LaunchAgents'), to: 'Library/LaunchAgents' }],
    ...(!signs && { identity: '-' }),
  },
  linux: {
    executableName: 'ted-app',
    target: ['AppImage', 'deb', 'rpm'],
    category: 'Development',
    synopsis: 'Runs software factories',
    maintainer: 'Kriya Design',
  },
  deb: {
    afterInstall: path.join(buildDir, 'linux', 'after-install.sh'),
    afterRemove: path.join(buildDir, 'linux', 'after-remove.sh'),
  },
  rpm: {
    afterInstall: path.join(buildDir, 'linux', 'after-install.sh'),
    afterRemove: path.join(buildDir, 'linux', 'after-remove.sh'),
  },
  publish: { provider: 'github', owner: releaseRepo.owner, repo: releaseRepo.repo },
}

const onMac = values.mac || (!values.linux && process.platform === 'darwin')
const onLinux = values.linux || (!values.mac && process.platform !== 'darwin')

execFileSync('pnpm', ['exec', 'vite', 'build'], { cwd: appDir, stdio: 'inherit' })
await stage()
const artifacts = await build({
  ...(onMac && { mac: [] }),
  ...(onLinux && { linux: [] }),
  ...(values.dir && { dir: true }),
  ...(values.x64 && { x64: true }),
  ...(values.arm64 && { arm64: true }),
  config,
  publish: 'never',
})
console.log(artifacts.join('\n'))
