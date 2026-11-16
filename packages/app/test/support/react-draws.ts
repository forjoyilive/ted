import type { ReactNode } from 'react'

interface Fiber {
  type: object | string | null
  memoizedProps: object | null
  child: Fiber | null
  sibling: Fiber | null
}

interface FiberRoot {
  current: Fiber
}

interface DrawCount {
  drawn: number
  seen: WeakSet<object>
}

const watched = new Map<object | string, DrawCount>()

function visit(fiber: Fiber | null): void {
  for (let node = fiber; node; node = node.sibling) {
    const count = node.type === null ? undefined : watched.get(node.type)
    if (count && node.memoizedProps && !count.seen.has(node.memoizedProps)) {
      count.seen.add(node.memoizedProps)
      count.drawn += 1
    }
    visit(node.child)
  }
}

// React reads this hook once, when react-dom loads, so it is installed from a setup file.
export function installDrawCounter(): void {
  Object.assign(globalThis, {
    __REACT_DEVTOOLS_GLOBAL_HOOK__: {
      supportsFiber: true,
      renderers: new Map(),
      inject: () => 1,
      onCommitFiberRoot: (_renderer: number, root: FiberRoot) => {
        if (watched.size > 0) visit(root.current)
      },
      onCommitFiberUnmount: () => {},
      onPostCommitFiberRoot: () => {},
    },
  })
}

export interface DrawCounter {
  readonly drawn: number
}

export function countDraws(component: (props: never) => ReactNode): DrawCounter {
  const count: DrawCount = { drawn: 0, seen: new WeakSet() }
  watched.set(component, count)
  return count
}
