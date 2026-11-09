export const exitWithPidEnv = 'TED_EXIT_WITH_PID'

export function watchExitWith(
  onGone: () => void,
  pidText = process.env[exitWithPidEnv],
  intervalMs = 500,
): void {
  const pid = Number(pidText)
  if (!Number.isInteger(pid) || pid <= 0) return
  const timer = setInterval(() => {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return
      clearInterval(timer)
      onGone()
    }
  }, intervalMs)
  timer.unref()
}
