# Antigravity

Choose Antigravity in the existing Task Lead, reviewer, planning, Coordinator, Automation or sub-agent controls. TED launches the official `agy` CLI through its Agent Client Protocol (ACP) interface. The initial supported version is 1.5.6.

Install the CLI using Google’s [installation guide](https://antigravity.google/docs/getting-started), then open Settings → Agents and choose Check again. TED’s Install and Sign in actions use the existing terminal setup flow. TED does not install or update the CLI automatically.

For Google AI Ultra, choose Subscription and sign in with the Google account that has the plan, using `agy acp --login`. TED excludes API and Cloud credentials from these Runs and requests personal Google authentication. TED does not infer the account’s subscription tier.

For separately billed Gemini access, add `GEMINI_API_KEY` to the daemon’s login-shell environment, choose API key, then Check again. TED requests the API-key authentication method explicitly; the key stays in the process environment. Health checks inspect CLI support and the presence of the selected sign-in method or key; they do not make model requests or create conversations. The subscription check uses the CLI’s non-secret method marker and can be stale if credentials are revoked. A successful health check does not prove that a key can access a particular model. Model access is checked on the first request. Failed ACP checks show CLI repair guidance; a CLI without ACP support offers Update. A missing API key shows environment setup guidance instead of Sign in. Do not put keys in Task descriptions or comments.

Enter a model supported by the account, or leave the model blank to use the CLI’s default. TED validates explicit model and effort choices against the server’s session options before sending work. Unsupported choices fail visibly. Existing agent defaults remain as configured.

Antigravity uses the normal Conversation, permission requests, steering, queue, stop and resume controls. Auto permissions enable the CLI’s sandbox; TED forwards one-operation permission grants, never permanent grants. Bypass permissions use the existing machine-controlled policy. Session recovery requires the server’s resume capability and does not replay history into the Conversation. TED does not guess costs or subscription usage figures.

Side chats and Automation instruction drafting use a private Antigravity profile and workspace. These select an agent with no declared tools, opt out of Antigravity’s default components, deny tool actions, exclude inherited customizations, hooks and MCP configuration, and cancel permission requests. An empty `tools` list alone does not remove the default task-management tool. The CLI’s Markdown agent profile must also set `excludeDefaultComponents: true` and `inheritCustomizations: false`. The driver stops if the CLI reports tool activity. The private workspace has its own repository root so a surrounding development checkout cannot supply customizations. Normal Automation Runs use the working agent interface.

For development and offline fixtures, `TED_ANTIGRAVITY_BIN` overrides the executable in TED Dev only. Release finds `agy` using the daemon’s normal login-shell `PATH`. Classifications and other overrides are described in [environment.md](../environment.md).

Protocol references: [Google’s ACP integration guide](https://antigravity.google/docs/ide/extensions/acp), [ACP v1](https://agentclientprotocol.com/protocol/v1/initialization). Real Ultra and valid API-key trials remain necessary in addition to offline coverage.
