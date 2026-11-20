import { execFileSync, spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import path from 'node:path'

export type Step = (title: string, command: string, args: string[]) => void

export const installedApp = '/Applications/Ted.app'

export function releaseDirIn(root: string): string {
  return path.join(root, 'packages/app/dist/release')
}

export function builtAppIn(root: string): string {
  return path.join(releaseDirIn(root), 'mac-arm64/Ted.app')
}

export function installedRunning(): boolean {
  return spawnSync('pgrep', ['-i', '-f', `${installedApp}/Contents/MacOS/`]).status === 0
}

export function copyIntoApplications(step: Step, built: string): void {
  rmSync(installedApp, { recursive: true, force: true })
  step('Copy', 'ditto', [built, installedApp])
}

// Side checkouts sit beside the repo, not in .git, because Vite refuses to serve files from
// inside a .git folder.
export function sideCheckout(root: string, suffix: string): string {
  const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: root,
    encoding: 'utf8',
  }).trim()
  return `${path.dirname(path.resolve(root, common))}-${suffix}`
}

export function packageApp(step: Step, { installers }: { installers: boolean }): void {
  step('Build', 'pnpm', ['package', '--mac', '--arm64', ...(installers ? [] : ['--dir'])])
}

export function smokeTest(step: Step): void {
  step('Smoke test the build', 'pnpm', ['--filter', '@ted/app', 'smoke'])
}

export function checkSignature(step: Step, app: string): void {
  step('Check the signature', 'codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
}

export const developerId = 'Developer ID Application: '

export function pickSigningIdentity(listing: string): string | undefined {
  return [...listing.matchAll(/"(Developer ID Application: [^"]+)"/g)].map((match) => match[1])[0]
}

// electron-builder refuses a CSC_NAME that starts with the certificate type and picks the
// Developer ID Application certificate for the name itself.
export function builderIdentity(name: string): string {
  return name.startsWith(developerId) ? name.slice(developerId.length) : name
}

export function signingRefusal(env: NodeJS.ProcessEnv): string | undefined {
  if (env.CSC_LINK) {
    return 'signing uses the keychain and can’t check a CSC_LINK certificate; unset CSC_LINK'
  }
  for (const name of ['CSC_NAME', 'TED_SIGN_IDENTITY'] as const) {
    const chosen = env[name]
    if (chosen && !chosen.startsWith(developerId)) {
      return `${name} must name a “${developerId}…” certificate, not “${chosen}”`
    }
  }
  return undefined
}

export function chosenSigningIdentity(env: NodeJS.ProcessEnv): string | undefined {
  const chosen = env.CSC_NAME || env.TED_SIGN_IDENTITY
  if (chosen) return chosen
  const listing = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8',
  })
  return pickSigningIdentity(listing)
}
