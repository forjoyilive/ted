export const insideTedSandbox = process.env.TED_SANDBOX === '1'

export const insideTedSandboxReason =
  'this run is inside Ted’s sandbox (a Scheduled Check), where a second sandbox can’t start, so a test that needs the real sandbox or checks what it refuses can’t run'

export const sandboxReasons = {
  secondSandbox: insideTedSandboxReason,
  tedHome:
    'tests whose files Ted refuses inside a Ted home: Ted’s sandbox keeps its temp folder under ~/.ted',
  processes:
    'tests that start or inspect processes (ps, a PTY, a process group): Ted’s sandbox refuses them',
  appStart: 'the app start script test: Ted Dev refuses to open inside Ted’s sandbox',
} as const

const reported = new Set<string>()

export function skipInsideTedSandbox(
  context: { skip: (condition: boolean, note?: string) => void },
  reason: string = sandboxReasons.secondSandbox,
): void {
  if (insideTedSandbox && !reported.has(reason)) {
    reported.add(reason)
    console.warn(`TED_SANDBOX_SKIPPED: ${reason}`)
  }
  context.skip(insideTedSandbox, reason)
}
