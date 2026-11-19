# Pi

Pi is a coding agent CLI (`pi`, npm package `@earendil-works/pi-coding-agent`) that runs models from many providers, local ones such as Ollama included. Choose Pi in the existing Task Lead, reviewer, planning, Coordinator, Automation, Instruction Check or sub-agent controls, or with `--provider pi` in the `ted` CLI.

## Install

Install it with `npm install -g @earendil-works/pi-coding-agent`, then open Settings → Providers and choose Check again. Ted’s Install and Update actions open that command (with `@latest` for Update) in the user’s own terminal. The minimum version is 1.5.2. Pi is Ready once it is installed, new enough, and `pi --list-models` lists at least one model.

## How Ted runs it

Ted starts `pi --mode rpc --approve --session-dir <run folder>/pi-sessions` with `--model` and `--thinking` when they are set, and drives it over Pi’s RPC protocol on stdin and stdout. A message sent while Pi is working steers the current turn; Stop sends `abort`. Pi keeps its sessions in the Run folder, and a Run resumes from its saved session file after a restart or sleep. Ted splits Pi’s output on LF only, because Pi’s JSON can hold U+2028 and U+2029, which Node’s `readline` treats as line breaks. Pi’s extension dialogs (select, confirm, input, editor) are answered as cancelled so a user extension can’t hold a Run.

Effort maps by name to `--thinking`: low, medium, high, xhigh and max; ultra becomes max. There is no Off.

## Models

Pi names a model `provider/id`, for example `ollama/gemma4:12b`. Type it under Other… in the model picker; the picker lists no models of its own for Pi. When no model is set on the request or in Ted’s defaults, Ted uses the default model in Pi’s own settings. When none of these names a model, Ted holds the work and asks the user to set one in the default model fields.

## The user’s setup

Pi uses the user’s own setup in `~/.pi/agent` (or `PI_CODING_AGENT_DIR`): providers, keys, settings and extensions. Ted reads Pi’s default model from there and never writes to it. The repo’s `.pi/` folder is trusted (`--approve`).

Side chats and Automation drafts start Pi with no tools: `--no-tools --no-mcp --no-extensions --no-skills --no-approve`.

## Permission modes

Pi runs only in Bypass Factories for now. In an Auto Factory all Pi work waits, tool-free chats included, until sandbox support arrives. Pi stays selectable there, and the pickers show “Pi work waits in this Factory until sandbox support arrives.”

## Offline, limits and billing

Pi is never paused for being offline or for usage limits, since its models may be local. It has no billing setting: Pi uses whatever keys its own settings hold. Settings → Providers shows its tokens per Run and the cost Pi reports, and plan usage reads “Not available”.

## Development

`TED_PI_BIN` points Ted Dev at another `pi` executable, such as the stub in `packages/daemon/test/fixtures/stub-pi.ts`; release finds `pi` on the daemon’s login-shell `PATH`. Tests set `PI_CODING_AGENT_DIR` to a missing folder so they never read the machine’s Pi setup. The optional real-Pi test in `packages/daemon/test/runs.test.ts` runs only when `TED_REAL_PI_BIN` names a Pi executable. See [environment.md](../environment.md).

Protocol references: Pi’s RPC docs ship in the npm package as `docs/rpc.md`, `docs/rpc-commands.md`, `docs/rpc-extension-ui.md` and `docs/json.md` ([package page](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)).
