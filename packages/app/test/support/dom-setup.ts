import { vi } from 'vitest'
import { installDrawCounter } from './react-draws.ts'

// jsdom has no canvas renderer; xterm probes it while the renderer modules load.
if (typeof HTMLCanvasElement !== 'undefined') {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null)
}

installDrawCounter()
