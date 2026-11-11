import { createContext } from 'react'

export type ArmAction = 'approve'

export const ArmedContext = createContext<Element | undefined>(undefined)
