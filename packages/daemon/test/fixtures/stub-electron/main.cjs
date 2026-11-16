const path = require('node:path')
const { app, BrowserWindow } = require('electron')

app.setPath('userData', path.join(process.env.TMPDIR || '/tmp', `stub-electron-${process.pid}`))
const locked = app.requestSingleInstanceLock()
app.on('window-all-closed', () => app.quit())
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: process.env.TED_ELECTRON_HIDDEN !== '1',
    width: 1000,
    height: 700,
  })
  await window.loadFile(path.join(__dirname, 'index.html'))
  await window.webContents.executeJavaScript(
    `document.getElementById('shown').textContent = 'visible ${window.isVisible()}'; document.getElementById('lock').textContent = 'single instance ${locked}'`,
  )
})
