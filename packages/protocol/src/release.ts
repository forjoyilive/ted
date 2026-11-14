export const releaseRepo = { owner: 'forjoyilive', repo: 'ted' } as const

export const releasesUrl = `https://github.com/${releaseRepo.owner}/${releaseRepo.repo}/releases`

export const downloadUrl = `${releasesUrl}/latest`

const newIssueBody =
  'What happened, and what did you expect?\n\n\n\nDiagnostic report (TED copied it to your clipboard; paste it here):\n\n'

export const newIssueUrl = `https://github.com/${releaseRepo.owner}/${releaseRepo.repo}/issues/new?body=${encodeURIComponent(newIssueBody)}`
