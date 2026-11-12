import { useCallback, useEffect, useRef, useState } from 'react'

export function useRefreshAction() {
  const [revision, setRevision] = useState(0)
  const sequence = useRef(0)
  const waiting = useRef(new Map<number, () => void>())
  const settled = useCallback((through: number) => {
    for (const [version, resolve] of waiting.current) {
      if (version <= through) {
        waiting.current.delete(version)
        resolve()
      }
    }
  }, [])
  const refresh = useCallback(() => {
    const version = ++sequence.current
    const completion = new Promise<void>((resolve) => waiting.current.set(version, resolve))
    setRevision(version)
    return completion
  }, [])
  useEffect(() => () => settled(Number.POSITIVE_INFINITY), [settled])
  return { revision, refresh, settled }
}
