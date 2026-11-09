export const releaseRepo = { owner: 'forjoyilive', repo: 'ted' } as const

export const releasesUrl = `https://github.com/${releaseRepo.owner}/${releaseRepo.repo}/releases`

export const downloadUrl = `${releasesUrl}/latest`
