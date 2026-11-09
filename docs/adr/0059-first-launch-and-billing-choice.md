# First launch is a machine setting, and Start at login waits for it

Status: accepted (KRI-115)

## Context

Spec 11.1 shows a full-window **Set up TED** screen once per machine, with rows for Claude Code, Codex, GitHub and Git, a **Start TED in the background when you log in** checkbox, **Skip for now** and **Continue**. Until this screen existed, ADR 0038 registered the login item at the first packaged start without asking. Each agent row also has an amber state for an API key, with **Use API-key billing** and **Sign in with a subscription instead**.

## Decision

- `firstLaunchDone` is a machine setting (ADR 0024), `false` by default. The renderer shows the Set up TED screen in place of the whole app while it is false. **Skip for now** and **Continue** both save `firstLaunchDone: true` with the checkbox’s value for `startAtLogin` in one `PATCH /settings`. **Continue** then opens the Add Factory form, which turns on Show the tutorial when there is no Factory; closing it leaves the Inbox showing “No Factories yet”.
- The app’s main process applies the login item only once `firstLaunchDone` is true. A human who closes TED on the Set up TED screen has no login item.
- The API-key row uses the `billing` setting and the `wrong-credential` state from ADR 0057. `billing` always holds a value (Subscription by default), so it can’t say “not chosen yet”. The row is amber exactly when the kind is `wrong-credential`: the CLI signs in with an API key while billing is Subscription, so a Run would pause. It shows the agent card’s `keySource` text. **Use API-key billing** sets that kind’s `billing` to `api-key`; **Sign in with a subscription instead** keeps Subscription and opens the CLI’s sign-in command in the user’s terminal, which `wrong-credential` now offers as its Fix. A key variable alone in the shell asks nothing, because Subscription removes it from the agent’s environment. An agent in this state doesn’t block **Continue**.
- Every row rechecks every 5 seconds for 10 minutes after a Fix (or after copying the Git identity commands), and whenever the window gains focus.
- Tests set `TED_SKIP_FIRST_LAUNCH=1` in `vitest.config.ts`; an unpackaged app marks first launch done at start when it is set. Tests of the screen launch with it empty.

## Considered Options

- **A marker file in the app’s `userData`.** The rest of the machine’s state lives in `~/.ted/`, and the daemon serves every client the same settings.
- **Keep registering the login item at the first start.** It would turn on a login item the human never saw offered.

## Consequences

- Settings → Agents shows the same Sign in fix on a `wrong-credential` card.
- An existing `~/.ted/` sees the Set up TED screen once after updating, then never again.
