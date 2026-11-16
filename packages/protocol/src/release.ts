export const releaseRepo = { owner: 'forjoyilive', repo: 'ted' } as const

export const releasesUrl = `https://github.com/${releaseRepo.owner}/${releaseRepo.repo}/releases`

export const downloadUrl = `${releasesUrl}/latest`

const newIssueBodies = {
  copied:
    'What happened, and what did you expect?\n\n\n\nDiagnostic report (Ted copied it to your clipboard; paste it here):\n\n',
  missing:
    'What happened, and what did you expect?\n\n\n\nTed couldn’t make a diagnostic report because its background service didn’t answer.\n',
}

export function newIssueUrl(reportCopied: boolean): string {
  const body = newIssueBodies[reportCopied ? 'copied' : 'missing']
  return `https://github.com/${releaseRepo.owner}/${releaseRepo.repo}/issues/new?body=${encodeURIComponent(body)}`
}
