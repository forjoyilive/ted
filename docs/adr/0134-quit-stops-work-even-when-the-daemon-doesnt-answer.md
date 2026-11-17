# Quit stops work even when the daemon doesn’t answer

Quit with “Stop them and quit” asked the daemon to stop every Run through `POST /shutdown` and gave up after 10 seconds. On 2026-11-12 the daemon was frozen for minutes at a time when the human quit: the app closed, the stop never ran, the Run hosts kept their agents working, and each agent’s `ted` command started a new daemon. Ted kept running after Quit, and the release install refused because Ted’s processes were still alive.

Three rules now make the human’s Quit hold:

- Before asking the daemon to stop, the app writes `TED_HOME/quit-mark` (created without following a link; only a plain file counts). While it exists, `withDaemon` refuses to start a daemon for any caller (`TedQuitError`), the daemon refuses to start once it holds its lock (`QuitMarkedError`, exit `tedQuitExitCode`), and a Run host refuses to start its agent. Only the app’s launch removes it (`clearQuit`), so neither an agent that drops its Run variables nor a reconnect still in flight can undo the Quit. A human `ted` command after Quit says to open Ted. A daemon that is already running is never refused.
- If `/shutdown` fails or doesn’t answer within the app’s wait, the app calls `stopTedProcesses`. It finds the processes holding `daemon-lock.db` or a Run’s `host.lock`, reading only plain folders and plain files and asking the OS (`lsof` in batches, or `/proc` on Linux) rather than trusting a stored pid. It signals each one’s process group when it leads one, so an agent and its children stop with their host. It sends SIGTERM, follows those same processes and groups, and sends SIGKILL to any still alive after 5 seconds. An `lsof` failure is an error, never “nothing to stop”.
- A Run ended this way is recorded at the next start as ended outside Ted, and the human is offered a restart, as for any Run whose host died.

A known gap: between Ted checking a Run folder and `lsof` reading it, a process that can write `TED_HOME/runs` could swap the lock path. Runs under Auto can’t write there, and under Bypass an agent can already signal any of the user’s processes, so this is accepted.

Keep running in the background is unchanged: it writes no mark and stops nothing.
