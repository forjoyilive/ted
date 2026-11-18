// @ts-check
// Plain JavaScript: Electron's sandboxed preload loader doesn't strip TypeScript types.
const { contextBridge, ipcRenderer } = require('electron')

/** @type {import('./renderer/ted.ts').TedBridge} */
const bridge = {
  request: (name, ...args) => ipcRenderer.invoke('ted:request', name, ...args),
  onEvent(listener) {
    /** @param {unknown} _event @param {any} data */
    const forward = (_event, data) => listener(data)
    ipcRenderer.on('ted:event', forward)
    return () => ipcRenderer.off('ted:event', forward)
  },
}

contextBridge.exposeInMainWorld('ted', bridge)
