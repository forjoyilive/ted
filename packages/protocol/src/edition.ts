export type Edition = 'release' | 'dev'

export const edition = 'dev' as Edition

export interface Identity {
  edition: Edition
  name: string
  homeFolder: string
  keyringService: string
}

const identities: Record<Edition, Identity> = {
  release: {
    edition: 'release',
    name: 'TED',
    homeFolder: '.ted',
    keyringService: 'TED',
  },
  dev: {
    edition: 'dev',
    name: 'TED Dev',
    homeFolder: '.ted-dev',
    keyringService: 'TED Dev',
  },
}

export function identity(which: Edition = edition): Identity {
  return identities[which]
}
