# Drive the official agent CLIs under the user’s own login

Anthropic’s and OpenAI’s terms allow a local app to start Claude Code and Codex when it runs the official, unmodified CLI and the user signs in through the vendor’s own login, with their own subscription or API key. Anthropic forbids third-party apps from offering Claude.ai login or collecting, storing or passing on its tokens, and requires API keys for products built on the Agent SDK. So TED starts the installed `claude` and `codex` binaries, as live sessions or in headless mode, and never touches credentials.

Rules for building TED:

- Start the user’s installed, unmodified CLIs. Never bundle, patch or wrap the binaries.
- Leave sign-in to the CLIs (`claude login`, `codex login`) or to the user’s own API key. TED has no sign-in screen of its own and never reads, copies or stores tokens or keys.
- With a Claude subscription, use the CLI, not the Agent SDK.
- Remove `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `CODEX_API_KEY` from the environment of the agents TED starts, unless the user has chosen API-key billing for that agent. A stray key silently moves the user to API billing. (Codex reads `CODEX_API_KEY`, not `OPENAI_API_KEY`, and it overrides every other login.) Keys the CLI stores itself, or Claude’s `apiKeyHelper`, can’t be removed this way, so TED compares the credential each Run reports with the user’s choice and pauses that agent when they differ ([KRI-54](https://linear.app/kriyadesign/issue/KRI-54)).
- Don’t pass `--bare`, and opt out if it becomes the default for `-p`; it ignores the subscription login.
- Respect plan limits: the limit on working Runs per machine stays on, and TED shows when an agent reports it has hit a usage limit.
- Keep how each agent signs in and starts behind one replaceable piece of code per agent kind, because these policies changed several times in 2026.

## Considered Options

- **Agent SDK for everything.** Cleaner to drive, but needs API keys for anyone not approved by Anthropic, which shuts out subscription users. Rejected.
- **TED-managed sign-in.** One login screen for both vendors. Forbidden for Claude.ai subscriptions. Rejected.

## Consequences

- Users must install and sign in to each CLI themselves before TED can use it; TED checks this and explains how.
- Anthropic has not said whether an app that runs the official binary counts as a “third-party harness” under its April 2026 rule, which moved those to pay-as-you-go billing. Codex’s app-server docs also say “App-server authentication has never been permitted for commercial or hosted services”; TED runs locally under the user’s own login, but that line needs the same recheck. Recheck before TED ships to other people, and read OpenAI’s Terms of Use and Codex help by hand (they couldn’t be fetched automatically). Sources: [KRI-21](https://linear.app/kriyadesign/issue/KRI-21) and `docs/research/claude-codex-terms.md` on the `research/claude-codex-terms` branch.
