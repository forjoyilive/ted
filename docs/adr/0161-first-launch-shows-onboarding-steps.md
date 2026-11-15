# First launch shows onboarding steps, and Developer mode can show them again

Status: accepted (TED-369)

## Context

ADR 0059 shows one Set up TED screen on a machine’s first launch. It checks tools but never says what TED is, so a new user meets Factories, Tasks, Stages, sign-offs and the Inbox with no explanation. Developers working on that first launch also had no way to see it again without a fresh home folder.

## Decision

- While `firstLaunchDone` is false, the renderer shows `Onboarding` (`packages/app/src/renderer/views/Onboarding.tsx`) in place of the app: Get ready to build faster, How it works, Set up TED (`FirstLaunch.tsx`, its checks unchanged) and, when there is no Factory, the Add Factory dialog. Every step shares `OnboardingFrame` and its footer: the step indicator, Skip, Back and Next. In the Add Factory dialog the same controls sit in the dialog’s footer, because the modal dialog blocks the page behind it.
- Onboarding ends when the user skips any step, finishes Set up TED with no Add Factory step, or closes or completes Add Factory. Ending saves `firstLaunchDone: true`, the checkbox’s `startAtLogin` and `onboardingOnNextOpen: false` in one write, as ADR 0059 does, so the main process still applies the login item only after onboarding.
- The checkbox starts unticked on a new machine. The stored default for `startAtLogin` stays `true`: the store saves only values that differ from the default, so a new default would turn off the login item for every existing user who never changed it.
- How it works draws its pictures with the Board card, request card, sidebar and button styles and sample data, not with the live `Board` or `RequestCard` components, which act on real Tasks. The pictures are `inert` and hidden from screen readers.
- `onboardingOnNextOpen` is a machine setting. Settings → Developer, with Developer mode on, sets it with **Show on next open** and clears it with **Undo**; nothing else changes until the app starts again. The main process checks it once per start, in its first `loadState`: when it is on and `firstLaunchDone` is true, it writes `firstLaunchDone: false`. The flag stays on until onboarding ends, which writes it off together with `firstLaunchDone: true`, so quitting in the middle of a reset and opening TED again still counts as a reset. While it is on, the checkbox starts at the current `startAtLogin`, and with a Factory already added onboarding has three steps.
- The renderer reads settings only after the main process has finished that first check (`startSettled`), so a store that opens slowly can’t show the app first and switch to onboarding a moment later.
- `TED_SKIP_FIRST_LAUNCH=1` still marks first launch done at start, after any reset is applied.
- Code calls the steps onboarding. On screen “onboarding” appears only on the Developer row.

## Considered Options

- **Turn `firstLaunchDone` off from the Developer row.** The renderer would show onboarding at once, in the middle of the session.
- **Keep the reset in the main process’s memory or `userData`.** A reset has to survive Quit, and machine state lives in the daemon’s settings (ADR 0059).
- **Render the live Board card and request card in How it works.** The Board card is drawn inside `Board`, and the request card’s buttons answer a real request.

## Consequences

- Set up TED’s **Skip for now** and **Continue** are now Skip and Next.
- Closing TED during onboarding leaves `firstLaunchDone` false, so onboarding starts again from the first step on the next start.
