import { vi } from 'vitest'
import { installDrawCounter } from './react-draws.ts'

// jsdom has no canvas renderer; xterm probes it while the renderer modules load.
if (typeof HTMLCanvasElement !== 'undefined') {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null)
}

// jsdom has no ResizeObserver; the sidebar's Factory list watches its size.
// Defined, not stubbed, so vi.unstubAllGlobals() after each test keeps it.
if (typeof HTMLElement !== 'undefined' && !('ResizeObserver' in globalThis)) {
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  })
}

installDrawCounter()
