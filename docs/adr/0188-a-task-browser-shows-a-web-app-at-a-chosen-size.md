# A Task browser shows a web App at a chosen size

Status: accepted (TED-563). Amends ADR 0097-task-browsers-use-an-authenticated-app-bridge.

A web App’s preview filled the middle pane, so a phone app looked like a stretched desktop site and there was no way to check a tablet or mobile layout without leaving Ted.

**Sizes.** `packages/protocol/src/preview-size.ts` names them: desktop (the pane, as before), tablet (768 × 1024), mobile (390 × 844), each of the two in portrait or landscape, and a custom width from 320 to 3840 px whose height fills the pane. A size travels as text (`desktop`, `mobile-landscape`, `1280`) through `previewSize` and `previewSizeValue`.

**Default per App.** A web App takes `preview: desktop|tablet|mobile` in `workflow.yaml`, set in Factory settings → Apps too. No key means desktop. Another kind of App gets a warning and the key is ignored. `TaskApp.preview` carries it to the app.

**One size per Task and App, held by the app.** The main process keeps the chosen size in `createTaskBrowsers` (`packages/app/src/browser.ts`), keyed by Task and App, apart from the browser session, so it survives switching views, Apps and App restarts, and ends when Ted quits. A new `size` browser action changes it. The human’s menu and an agent’s `ted browser size` send the same action through the daemon, so both see one size; `browserState` returns it, with `sizeByAgent` when an agent chose it, and the renderer says so in the status line. `size` works only in a Task’s browser; an Automation Run’s headless browser keeps `resize`.

**Emulation through the page’s debugger.** `preview-emulation.ts` turns a size into `Emulation.setDeviceMetricsOverride`; tablet and mobile also get touch support (`Emulation.setTouchEmulationEnabled`) and an iPad or iPhone Safari user agent and platform. The page reloads when touch or the user agent changes, because a document reads them when it starts. Desktop clears the overrides and restores Electron’s own user agent. The human’s mouse stays a mouse: `Emulation.setEmitTouchEventsForMouse` made `Input.dispatchMouseEvent` hang in testing, which would block agents’ clicks.

**Zoom is the human’s alone.** The renderer draws tablet, mobile and custom sizes in a centred frame and picks a scale (`previewFrame`): Fit by default, or 50%, 75% or 100%, never more than fits. It passes the scale to `presentBrowser`, and the main process applies it as the override’s `scale`, so the page keeps its layout width. Under a scale, `Input.dispatchMouseEvent` takes coordinates in the scaled view, so `runOnPage` multiplies agents’ click points by `inputScale`. Screenshots of an emulated page come from `Page.captureScreenshot`, which gives the page at its own size whatever the zoom; when that capture doesn’t answer in 5 seconds, as can happen for a view that isn’t on screen, the old window capture is used.

## Consequences

- An agent changing the size changes the human’s preview, and the other way round. That is the point: both look at one page.
- A switch between a device size and desktop or custom reloads the page, and a form the human was filling in is lost.
- The size is gone after Ted quits; the App’s default applies again.
