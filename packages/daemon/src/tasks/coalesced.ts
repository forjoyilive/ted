export function coalesced<Key = void>(work: (key: Key) => void): (key: Key) => void {
  const pending = new Set<Key>()
  return (key) => {
    if (pending.has(key)) return
    pending.add(key)
    setImmediate(() => {
      pending.delete(key)
      work(key)
    })
  }
}
