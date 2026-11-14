export function sandboxRefusal(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.TED_SANDBOX !== '1' || process.platform !== 'darwin') return undefined
  return 'TED Dev can’t open inside TED’s sandbox: macOS stops Electron registering as an app there, so it would crash. Try the app with `withApp` from packages/app/scripts/with-app.ts or its Playwright tests, outside the sandbox, or ask the human to start TED Dev with ▶.'
}
