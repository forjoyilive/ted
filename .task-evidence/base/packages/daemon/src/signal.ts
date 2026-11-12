function isPid(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 1
}

// kill(2) reads pid 0 as the caller's process group and -1 as every process
// the user may signal, so a pid read from a file must be checked first.
export function signalProcess(pid: unknown, signal: NodeJS.Signals): void {
  if (isPid(pid)) process.kill(pid, signal)
}

export function signalGroup(pgid: unknown, signal: NodeJS.Signals): void {
  if (isPid(pgid)) process.kill(-pgid, signal)
}
