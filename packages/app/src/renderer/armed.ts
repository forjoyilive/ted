import { createContext } from 'react'

export type ArmAction = 'approve' | 'accept-recommended'

export const ArmedContext = createContext<Element | undefined>(undefined)
