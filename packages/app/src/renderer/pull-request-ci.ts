import type { CiSignal, PullRequestCiFound, PullRequestCiMode } from '@ted/protocol'

export const pullRequestCiLabels: Record<PullRequestCiMode, string> = {
  auto: 'Detect',
  none: 'None: don’t wait',
  required: 'Always wait for CI',
}

const reasons: Record<CiSignal, string> = {
  'workflow-files': 'a GitHub Actions workflow runs on this branch',
  'required-checks': 'the base branch requires a check',
  'recent-pull-requests': 'recent pull requests had checks',
  'recent-checks': 'recent commits on the base branch had checks',
}

export function ciFoundText(
  found: PullRequestCiFound | undefined,
  mode: PullRequestCiMode,
  when: (iso: string) => string,
): string {
  if (!found) return 'Not checked yet. TED checks when a Task first pushes to this repo.'
  const pushed = `when ${found.task} pushed, ${when(found.at)}`
  const required = found.signals.includes('required-checks')
  const result =
    found.signals.length === 0
      ? `None found ${pushed}.`
      : `Found ${pushed}: ${found.signals.map((s) => reasons[s]).join(', ')}.`
  if (mode === 'none' && required) {
    return `${result} TED still waits for the required check, because GitHub won’t merge without it.`
  }
  if (mode !== 'auto') return `${result} This setting overrides it.`
  return found.signals.length === 0
    ? `${result} TED doesn’t wait for CI on this repo’s pull requests.`
    : result
}
