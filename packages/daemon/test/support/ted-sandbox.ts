export const insideTedSandbox = process.env.TED_SANDBOX === '1'

export const insideTedSandboxReason =
  'this run is inside TED’s sandbox (a Scheduled Check), where a second sandbox can’t start, so a test that needs the real sandbox or checks what it refuses can’t run'

export const sandboxReasons = {
  secondSandbox: insideTedSandboxReason,
  tedHome:
    'tests whose files TED refuses inside a TED home: TED’s sandbox keeps its temp folder under ~/.ted',
  processes:
    'tests that start or inspect processes (ps, a PTY, a process group): TED’s sandbox refuses them',
  appStart: 'the app start script test: TED Dev refuses to open inside TED’s sandbox',
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
