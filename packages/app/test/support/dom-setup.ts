import { vi } from 'vitest'

// jsdom has no canvas renderer; xterm probes it while the renderer modules load.
if (typeof HTMLCanvasElement !== 'undefined') {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null)
}
