# Quit stops work even when the daemon doesn’t answer

Quit with “Stop them and quit” asked the daemon to stop every Run through `POST /shutdown` and gave up after 10 seconds. On 2026-11-12 the daemon was frozen for minutes at a time when the human quit: the app closed, the stop never ran, the Run hosts kept their agents working, and each agent’s `ted` command started a new daemon. TED kept running after Quit, and the release install refused because TED’s processes were still alive.

Two rules now make the human’s Quit hold:

- Before asking the daemon to stop, the app writes `TED_HOME/quit-mark`. While it exists, `withDaemon` refuses to start a daemon for a caller with a Run token (`TedQuitError`), and `main.ts` exits with `tedQuitExitCode` when started without the app’s key, which closes the race where a Run’s command was already starting one. The app, the human’s `ted` and any other caller without a Run token remove the mark before they start a daemon. A daemon that is already running is never refused.
- If `/shutdown` fails or doesn’t answer within the app’s wait, the app calls `stopTedProcesses`: SIGTERM to every process holding `daemon-lock.db` or a Run’s `host.lock`, then SIGKILL to those still holding one after 5 seconds. Holders come from the OS (`lsof`, or `/proc` on Linux), never from a stored pid, so a reused pid is never signalled.

A Run ended this way is recorded at the next start as ended outside TED, and the human is offered a restart, as for any Run whose host died. Keep running in the background is unchanged: it writes no mark and stops nothing.
