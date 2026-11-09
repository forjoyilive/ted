# First launch is a machine setting, and Start at login waits for it

Status: accepted (KRI-115)

## Context

Spec 11.1 shows a full-window **Set up TED** screen once per machine, with rows for Claude Code, Codex, GitHub and Git, a **Start TED in the background when you log in** checkbox, **Skip for now** and **Continue**. Until this screen existed, ADR 0038 registered the login item at the first packaged start without asking. The Claude Code row also has an amber state for an API key, with **Use API-key billing** and **Sign in with a subscription instead**, which needs somewhere to keep the choice.

## Decision

- `firstLaunchDone` is a machine setting (ADR 0024), `false` by default. The renderer shows the Set up TED screen in place of the whole app while it is false. **Skip for now** and **Continue** both save `firstLaunchDone: true` with the checkbox’s value for `startAtLogin` in one `PATCH /settings`. **Continue** then opens the Add Factory form, which turns on Show the tutorial when there is no Factory; closing it leaves the Inbox showing “No Factories yet”.
- The app’s main process applies the login item only once `firstLaunchDone` is true. A human who closes TED on the Set up TED screen has no login item.
- `billing` is a machine setting holding `subscription` or `api-key` per agent kind, empty until the human picks one. Agent health gains `credential` (what the CLI’s own login uses) and `apiKey` (a sentence saying where a key comes from: the CLI’s login, or one of the agent’s key variables set in the login shell). The row is amber while `apiKey` is set and no billing is chosen, or Subscription is chosen but the CLI still signs in with a key. A CLI signed in with a key also gets a **Sign in** fix, so **Sign in with a subscription instead** opens its sign-in command in the user’s terminal like any other Fix.
- Every row rechecks every 5 seconds for 10 minutes after a Fix (or after copying the Git identity commands), and whenever the window gains focus.
- Tests set `TED_SKIP_FIRST_LAUNCH=1` in `vitest.config.ts`; an unpackaged app marks first launch done at start when it is set. Tests of the screen launch with it empty.

## Considered Options

- **A marker file in the app’s `userData`.** The rest of the machine’s state lives in `~/.ted/`, and the daemon serves every client the same settings.
- **Keep registering the login item at the first start.** It would turn on a login item the human never saw offered.

## Consequences

- KRI-113 (billing per agent kind) reads `billing` and removes the key variables under Subscription; this ticket only stores the choice.
- An existing `~/.ted/` sees the Set up TED screen once after updating, then never again.
