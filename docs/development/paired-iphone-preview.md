# Paired iPhone previews

In Validate, run `ted run-app "Ted Dev iPhone"` from the Task. Ted starts the local relay and an isolated Ted Dev before it builds and boots the Task’s simulator. The Task can contain only `ted-mobile`. If it has no `ted` worktree, the preview checks out a commit from the desktop repo’s default branch.

1. Run `ted app screen "Ted Dev iPhone"` and open “Pair with your Mac” if needed.
2. Run `ted app list` and find the port for **Ted Dev Preview**. Connect to its page on loopback with Playwright’s `chromium.connectOverCDP` or Node’s `WebSocket` and Chrome DevTools Protocol. For direct CDP, get the page’s `webSocketDebuggerUrl` from `http://127.0.0.1:<port>/json/list` and use `Runtime.evaluate` with `awaitPromise` and `returnByValue`.
3. Evaluate `window.ted.request('createPhonePairing')` in that page. Pass the returned link directly to `execFileSync('ted', ['app', 'pair', 'Ted Dev iPhone'], { input: offer.link })` without printing it.
4. Read the phone’s six digits with `ted app screen "Ted Dev iPhone"`. In the desktop page, read `window.ted.request('currentPhonePairing')` and wait for its `waiting` state. Compare the codes, then approve with `window.ted.request('approvePhonePairing', { pairing: offer.pairing })` in that same page.
5. Navigate to the screen with `ted app screen` and `ted app tap`, then attach it to the Task with `ted app screenshot "Ted Dev iPhone"`.
6. Run `ted app stop "Ted Dev iPhone"` when finished. This also stops the relay and desktop preview.

The preview stores its daemon data, Electron profile and relay state in Task-specific scratch storage. Its pairing keys live in memory. Pair again if the preview desktop restarts.
