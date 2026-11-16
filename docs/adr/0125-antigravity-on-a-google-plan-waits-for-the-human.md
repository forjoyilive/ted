# Antigravity on a Google plan waits for the human to accept Google’s terms notice

Google’s Antigravity Additional Terms (section 6) call using third-party software to access the service a breach that can end in suspension of the Antigravity and Gemini CLI accounts, and Google’s FAQ says wrapping `agy` in third-party applications is not supported under consumer plans and recommends an API key for third-party coding agents. Ted drives the Antigravity CLI from a wrapper. Anthropic’s and OpenAI’s published terms say nothing comparable about running their unmodified CLIs.

- **A machine setting, `antigravityPlanAccepted`, off by default.** Only the app can change settings, so only the human can turn it on.
- **Without it, nothing starts Antigravity under Subscription billing.** `launchBilling` in `runs/run-manager.ts` is on the path of every agent launch (a new Run, a restart, a revive, a replacement) and refuses with `antigravityPlanNotice`. Antigravity’s health check answers the same notice as a problem, so the agent is not Ready, its work waits, and its banner opens Settings → Agents. The health monitor records the pause when it is created, before its first check, so queued work sees it at once.
- **Settings → Agents shows the notice** in Antigravity’s Billing section, with the terms address and **Use my Google plan anyway**, which sets the setting. Choosing API key removes the hold without accepting anything.
- **API-key billing is not affected.**

## Considered Options

- **Remove Subscription billing for Antigravity.** The terms were read on 2026-11-11 and can change, and some Google plans may allow it; a hold is easier to lift than a removed path is to restore.
- **A note in Settings only.** Someone who never opens Settings would run it without knowing the risk, and the account at risk is theirs.

## Consequences

- A home that ran Antigravity on a Google plan finds it paused after updating, until the human accepts or switches to an API key.
- An Antigravity Run that is working when the update lands goes on until it ends or restarts; Ted doesn’t stop it.
- The notice’s wording and the terms address are in `packages/protocol/src/health.ts`. Review them when Google’s terms change.
