export async function eventWait<T>(
  subscribe: (changed: () => void) => (() => void) | Promise<() => void>,
  check: () => T | undefined | false | Promise<T | undefined | false>,
  what: string,
  timeoutMs = 20_000,
): Promise<T> {
  const result = Promise.withResolvers<T>()
  let done = false
  let checking = false
  let dirty = false
  let unsubscribe: (() => void) | undefined
  const timer = setTimeout(
    () => result.reject(new Error(`timed out waiting for ${what}`)),
    timeoutMs,
  )
  async function changed() {
    dirty = true
    if (checking || done) return
    checking = true
    try {
      while (dirty && !done) {
        dirty = false
        const value = await check()
        if (value !== undefined && value !== false) {
          done = true
          result.resolve(value)
        }
      }
    } catch (error) {
      result.reject(error)
    } finally {
      checking = false
    }
  }
  try {
    // The rejection handler is installed before an asynchronous subscription can fail or time out.
    const subscribed = Promise.resolve()
      .then(() =>
        subscribe(() => {
          void changed()
        }),
      )
      .then((close) => {
        if (done) close()
        else unsubscribe = close
      })
    await Promise.race([subscribed, result.promise])
    void changed()
    return await result.promise
  } finally {
    done = true
    clearTimeout(timer)
    unsubscribe?.()
  }
}
