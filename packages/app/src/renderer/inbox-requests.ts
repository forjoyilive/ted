import { createContext } from 'react'

export const InboxRequestsContext = createContext<
  | {
      selected: string | undefined
      resolved: ReadonlySet<string>
      select: (id: string) => void
    }
  | undefined
>(undefined)
