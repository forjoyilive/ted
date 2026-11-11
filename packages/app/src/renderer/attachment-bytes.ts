import type { Attachment } from '@ted/protocol'
import { useEffect, useState } from 'react'
import { readableError, ted } from './ted.ts'

export function useBytes({ hash, name }: Pick<Attachment, 'hash' | 'name'>): {
  data?: string
  error?: string
} {
  const [state, setState] = useState<{ data?: string; error?: string }>({})
  useEffect(() => {
    let current = true
    ted
      .readAttachment({ hash, name })
      .then(({ data }) => current && setState({ data }))
      .catch((failed: unknown) => current && setState({ error: readableError(failed) }))
    return () => {
      current = false
    }
  }, [hash, name])
  return state
}
