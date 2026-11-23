import { randomUUID } from 'node:crypto'
import { BrowserWindow, session, type WebPreferences } from 'electron'

function webAddress(address: string): URL | undefined {
  const url = URL.parse(address)
  if (
    url &&
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    !url.username &&
    !url.password
  )
    return url
}

export async function openAppSignInWindow(name: string, address: string): Promise<void> {
  const privateSession = session.fromPartition(`app-sign-in-${randomUUID()}`)
  privateSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  privateSession.setPermissionCheckHandler(() => false)
  privateSession.on('will-download', (event) => event.preventDefault())

  const webPreferences: WebPreferences = {
    session: privateSession,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    devTools: false,
  }
  const window = new BrowserWindow({
    title: `${name} · Sign-in window`,
    width: 1050,
    height: 760,
    show: false,
    autoHideMenuBar: true,
    webPreferences,
  })
  const popups = new Set<BrowserWindow>()

  function protect(child: BrowserWindow, initialAddress: string) {
    const contents = child.webContents
    const setTitle = (current: string) => {
      const origin = webAddress(current)?.origin
      child.setTitle(origin ? `${name} · Sign-in window · ${origin}` : `${name} · Sign-in window`)
    }
    setTitle(initialAddress)
    child.on('page-title-updated', (event) => event.preventDefault())
    contents.on('select-client-certificate', (event, _url, _certificates, callback) => {
      event.preventDefault()
      // SAFETY: Electron accepts no argument to continue without a client certificate.
      const decline = callback as () => void
      decline()
    })
    contents.on('will-frame-navigate', (event) => {
      if (event.isMainFrame && !webAddress(event.url)) event.preventDefault()
    })
    contents.on('will-redirect', (event) => {
      if (event.isMainFrame && !webAddress(event.url)) event.preventDefault()
    })
    contents.on('did-navigate', (_event, url) => setTitle(url))
    contents.setWindowOpenHandler(({ url }) =>
      url === 'about:blank' || webAddress(url)
        ? {
            action: 'allow',
            overrideBrowserWindowOptions: { webPreferences, autoHideMenuBar: true },
          }
        : { action: 'deny' },
    )
    contents.on('did-create-window', (popup, details) => {
      popups.add(popup)
      popup.once('closed', () => popups.delete(popup))
      protect(popup, details.url)
    })
  }

  protect(window, address)
  window.once('closed', () => {
    for (const popup of popups) popup.destroy()
    void privateSession.clearData().catch(() => {})
    void privateSession.closeAllConnections().catch(() => {})
  })
  window.show()
  try {
    await window.loadURL(address)
  } catch {
    if (!window.isDestroyed()) {
      window.destroy()
      throw new Error('Couldn’t load the App’s sign-in window')
    }
  }
}
