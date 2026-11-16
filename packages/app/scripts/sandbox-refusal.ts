export function sandboxRefusal(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.TED_SANDBOX !== '1' || env.TED_SANDBOX_ELECTRON === '1' || process.platform !== 'darwin')
    return undefined
  return 'Ted Dev can’t open inside Ted’s sandbox: macOS stops Electron registering as an app there, so it would crash. Try the app with `withApp` from packages/app/scripts/with-app.ts or its Playwright tests, outside the sandbox, run it as an Electron App (`electron: true` in workflow.yaml), or ask the human to start Ted Dev with ▶.'
}
