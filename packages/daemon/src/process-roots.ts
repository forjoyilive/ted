export interface ProcessRoot {
  kind: 'check' | 'app'
  task?: string
  appName?: string
}

const roots = new Map<number, ProcessRoot>()

export function markProcessRoot(pid: number, root: ProcessRoot): () => void {
  roots.set(pid, root)
  return () => {
    if (roots.get(pid) === root) roots.delete(pid)
  }
}

export function processRoot(pid: number): ProcessRoot | undefined {
  return roots.get(pid)
}
