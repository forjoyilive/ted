import type { AutomationTemplate } from '@ted/protocol'

const linear = `Bring the Linear issues assigned to me into TED as Tasks.

1. With your own Linear tools (the Linear MCP server or CLI you are signed in to), list the issues assigned to me that haven’t been started yet (Triage, Backlog, Todo), in every team.
2. For each one, run \`ted task create --source <the issue’s URL> "<the issue’s title>"\`. When TED says an issue is already tracked, leave it and move on.
3. Don’t pass \`--start\`: new Tasks wait in Backlog until I start them.
4. Don’t change anything in Linear.

End with one line naming the Tasks you created, or “No new Tasks”.`

const sentry = `Turn new Sentry issues into Tasks, and catch fixes that didn’t hold.

1. With your own Sentry tools (the Sentry MCP server or \`sentry-cli\`), list the unresolved issues in this Factory’s Sentry projects that are new or regressed since this Automation last ran. Skip issues with fewer than 5 events unless they crash the app.
2. For each new issue, run \`ted task create --source <the Sentry issue’s URL> --description "<what>" "<short title>"\`. In the description give the error, the top frames of the stack, the event count, the first and last release it was seen in, and this line: “Put \`Fixes <SENTRY-SHORT-ID>\` in the pull request body.” That line lets Sentry resolve the issue in the release that ships the fix, and flag it as regressed if events come back from that release or a later one.
3. When TED refuses because the issue’s Task is Done, it tells you when that Task merged and its commit. Whether the fix held is your judgement, not TED’s:
   - Create a Follow-up only when the issue has events from a release that contains that commit, or when Sentry marks the issue regressed. Events from older releases are old builds still in use, not a failed fix. This matters most for mobile apps, where a fix can take weeks to reach users.
   - Only for projects that don’t report releases, such as a web app deployed on every merge, fall back to “events after the merge date”.
   - To create one, run \`ted task create --follow-up <Task ID> --source <the Sentry issue’s URL> "<short title>"\`.
4. When TED says an issue is already tracked by an open Task, or was archived, leave it.
5. Don’t pass \`--start\`, and don’t resolve, assign or comment on anything in Sentry.

End with one line naming the Tasks and Follow-ups you created, or “No new Tasks”.`

const github = `Triage this Factory’s new GitHub issues.

1. For each of this Factory’s repos, list the open issues created since this Automation last ran (or in the last day): \`gh issue list --repo <owner/repo> --state open --search "created:>=<date>"\`.
2. Create a Task for each issue that reports a bug or asks for a small, clear change: \`ted task create --source <the issue’s URL> "<the issue’s title>"\`. When TED says an issue is already tracked, leave it.
3. Skip questions, duplicates and large feature requests. Name them in your final message instead, one line each with why.
4. Don’t pass \`--start\`, and don’t comment on, label or close anything on GitHub.

End with one line naming the Tasks you created, or “No new Tasks”, then the issues you skipped.`

export const automationTemplates: readonly AutomationTemplate[] = [
  {
    id: 'linear',
    name: 'Pull new Linear issues assigned to me',
    prompt: linear,
    schedule: { kind: 'every', every: 30, unit: 'minutes' },
  },
  {
    id: 'sentry',
    name: 'Turn new Sentry issues into Tasks',
    prompt: sentry,
    schedule: { kind: 'weekdays', at: '09:00' },
  },
  {
    id: 'github',
    name: 'Daily GitHub issue triage',
    prompt: github,
    schedule: { kind: 'daily', at: '09:00' },
  },
]
