export function sandboxRefusal(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (process.platform !== 'darwin') return undefined
  if (env.CODEX_SANDBOX !== undefined)
    return 'Ted Dev can’t open inside Codex’s sandbox: macOS stops Electron registering as an app there, so it would crash. Run the launcher outside Codex’s sandbox or use `ted run-app "Ted Dev"` from a Ted Run.'
  if (env.TED_SANDBOX !== '1' || env.TED_SANDBOX_ELECTRON === '1') return undefined
  return 'Ted Dev can’t open inside Ted’s sandbox: macOS stops Electron registering as an app there, so it would crash. Try the app with `withApp` from packages/app/scripts/with-app.ts or its Playwright tests, outside the sandbox, run it as an Electron App (`electron: true` in workflow.yaml), or ask the human to start Ted Dev with ▶.'
}
