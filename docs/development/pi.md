# Pi

Pi is a coding agent CLI (`pi`, npm package `@earendil-works/pi-coding-agent`) that runs models from many providers, local ones such as Ollama included. Choose Pi in the existing Task Lead, reviewer, planning, Coordinator, Automation, Instruction Check or sub-agent controls, or with `--provider pi` in the `ted` CLI.

## Install

Install it with `npm install -g @earendil-works/pi-coding-agent`, then open Settings → Providers and choose Check again. Ted’s Install and Update actions open that command (with `@latest` for Update) in the user’s own terminal. The minimum version is 1.5.2. Pi is Ready once it is installed, new enough, and `pi --list-models` lists at least one model.

## How Ted runs it

Ted starts `pi --mode rpc --approve --session-dir <run folder>/pi-sessions` with `--model` and `--thinking` when they are set, and drives it over Pi’s RPC protocol on stdin and stdout. A message sent while Pi is working steers the current turn; Stop sends `abort`. Pi keeps its sessions in the Run folder, and a Run resumes from its saved session file after a restart or sleep; if that file is missing, Ted refuses the resume rather than pass Pi a bare session ID, which can make Pi stop and ask on stdin. Ted splits Pi’s output on LF only, because Pi’s JSON can hold U+2028 and U+2029, which Node’s `readline` treats as line breaks. Pi’s extension dialogs (select, confirm, input, editor) are answered as cancelled so a user extension can’t hold a Run.

Effort maps by name to `--thinking`: low, medium, high, xhigh and max; ultra becomes max. There is no Off.

## Models

Pi names a model `provider/id`, for example `ollama/gemma4:12b`. Type it under Other… in the model picker; the picker lists no models of its own for Pi. When no model is set on the request or in Ted’s defaults, Ted uses the default model in Pi’s own settings. When none of these names a model, Ted holds the work and asks the user to set one in the default model fields.

## The user’s setup

Pi uses the user’s own setup in `~/.pi/agent` (or `PI_CODING_AGENT_DIR`): providers, keys, settings and extensions. Ted reads Pi’s default model from there and never writes to it. The repo’s `.pi/` folder is trusted (`--approve`).

Side chats and Automation drafts start Pi with no tools: `--no-tools --no-mcp --no-extensions --no-skills --no-approve`.

## Permission modes

In a Bypass Factory Pi runs as before, with no sandbox. Everywhere else, including planning chats, Automations, Coordinator chats, side chats and Automation drafts in any Factory, Ted runs the `pi` process inside its own OS sandbox (`sandbox-exec` on macOS, `bwrap` on Linux). A blocked action fails as a command error in the Run’s chat; nobody is asked. Network stays on.

In a Task, Pi can write the Task’s worktrees and the git data it needs to commit, and its own Run folders. Outside a Task it writes only its Run folders and a worktree the Run owns. It can read `~/.pi/agent` but not write it, so a refreshed Pi sign-in isn’t saved; commands can read `~/.pi/agent/auth.json`. The repo’s `.pi/` folder stays trusted and runs inside the sandbox. `ted` works inside the sandbox: it finds the daemon through `TED_HOME/public/daemon.json`, which holds no token. Ted’s Runs don’t appear in Pi’s resume list.

When the sandbox doesn’t work on the machine, Pi work outside Bypass waits with “Ted can’t sandbox Pi here (reason). Pi will run every command without asking. Run it anyway?”, and a banner opens Settings → Providers. The Pi card there has a Sandbox section with the reason and the switch “Run Pi without a sandbox in Auto Factories”. Only the app can turn it on; with it on, Pi runs without a sandbox there. While the sandbox works, the switch has no effect.

## Offline, limits and billing

Pi is never paused for being offline or for usage limits, since its models may be local. A turn that ends in a model error, such as a rate limit after Pi’s own retries or a stopped Ollama, ends the Run with Pi’s message, and the Run can be retried. It has no billing setting: Pi uses whatever keys its own settings hold. Settings → Providers shows its tokens per Run and the cost Pi reports, and plan usage reads “Not available”.

## Development

`TED_PI_BIN` points Ted Dev at another `pi` executable, such as the stub in `packages/daemon/test/fixtures/stub-pi.ts`; release finds `pi` on the daemon’s login-shell `PATH`. Tests set `PI_CODING_AGENT_DIR` to a missing folder so they never read the machine’s Pi setup. The optional real-Pi test in `packages/daemon/test/runs.test.ts` runs only when `TED_REAL_PI_BIN` names a Pi executable. See [environment.md](../environment.md).

Protocol references: Pi’s RPC docs ship in the npm package as `docs/rpc.md`, `docs/rpc-commands.md`, `docs/rpc-extension-ui.md` and `docs/json.md` ([package page](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)).
