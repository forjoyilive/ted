import type { MachineSettings } from '@ted/protocol'
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react'
import { useConnection } from './data.ts'
import { ted } from './ted.ts'

const ProfileContext = createContext<{ name: string; photo?: string | undefined }>({ name: 'You' })

export function ProfileProvider({
  settings,
  children,
}: {
  settings: MachineSettings | undefined
  children: ReactNode
}) {
  const [name, setName] = useState('You')
  const { epoch } = useConnection()
  useEffect(() => {
    void epoch
    let active = true
    void ted.getProfile().then(
      (profile) => {
        if (active) setName(profile.name.trim() || 'You')
      },
      () => undefined,
    )
    return () => {
      active = false
    }
  }, [epoch])
  return (
    <ProfileContext value={{ name, photo: settings?.profilePicture ?? undefined }}>
      {children}
    </ProfileContext>
  )
}

export const useProfile = () => useContext(ProfileContext)
