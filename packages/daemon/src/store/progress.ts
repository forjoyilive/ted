let onMaterialized: (() => void) | undefined

export function countMaterialized(listener: (() => void) | undefined): void {
  onMaterialized = listener
}

export function counted<T extends Record<string, (...args: never[]) => unknown>>(handlers: T): T {
  return Object.fromEntries(
    Object.entries(handlers).map(([name, handler]) => [
      name,
      (...args: never[]) => {
        onMaterialized?.()
        return handler(...args)
      },
    ]),
  ) as T
}
