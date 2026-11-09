export function startIdleTimer({ afterMs, onIdle }: { afterMs: number; onIdle: () => void }) {
  let timer = setTimeout(onIdle, afterMs)
  return {
    reset() {
      clearTimeout(timer)
      timer = setTimeout(onIdle, afterMs)
    },
    cancel() {
      clearTimeout(timer)
    },
  }
}
