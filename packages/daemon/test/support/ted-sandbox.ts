export const insideTedSandbox = process.env.TED_SANDBOX === '1'

export const insideTedSandboxReason =
  'this run is inside TED’s sandbox (a Scheduled Check), where a second sandbox can’t start, so a test that needs the real sandbox or checks what it refuses can’t run'

export function skipInsideTedSandbox(context: {
  skip: (condition: boolean, note?: string) => void
}): void {
  context.skip(insideTedSandbox, insideTedSandboxReason)
}
