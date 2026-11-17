# Sandboxed commands reach only listed Unix sockets, and Linux binds folders by descriptor

Status: accepted. Amends ADR 0091 (Checks and Apps run in an OS sandbox outside Bypass). Answers KRI-221.

## Context

ADR 0091 left these limits open:

1. Teardown ran unsandboxed. ADR 0096 already closed it, including teardown started by `ted task repos remove`.
2. Sockets were open. A sandboxed command could ask a Docker daemon, an ssh-agent, a tmux server or another local service to run something, and that ran outside the sandbox.
3. A Linux race. `bwrap` resolves its bind paths when it starts. In a multi-repo Factory the Task Lead can write the Task folder that holds the worktrees, so swapping a worktree for a link between Ted’s check and `bwrap`’s start could widen what a Check may write.
4. Linux is untested on the machines that built this.

## Decision

**Unix sockets are closed unless listed.** A sandboxed command (a Check, an App an agent or Ted starts, worktree setup or teardown) can connect only to Unix sockets inside the Task’s own writable folders, temp folder and caches, and to the ones the Workflow lists in `sandbox_sockets`:

```yaml
sandbox_sockets: [~/.docker/run/docker.sock, $SSH_AUTH_SOCK]
```

Each entry is an absolute path, a `~/` path or a whole `$NAME`. Ted expands `~` and `$NAME` from the daemon’s login-shell environment at each start, because ssh-agent’s socket path changes at every login; an entry that doesn’t expand to an absolute path is skipped and logged. `ted workflow check` refuses anything else. The key may be set in any layer; the later layer’s list replaces the earlier one. The Workflow is read from `origin/<default branch>` and the Library, never from the worktree, so an agent can’t widen its own list. It applies only outside Bypass, since Bypass has no sandbox. There is no Factory settings row for it yet; it is edited in YAML.

- **macOS.** The Seatbelt profile denies `network-outbound` to every Unix socket, then allows the Task’s folders by `subpath` and the listed paths by `path-literal`, all passed as `-D` parameters. Seatbelt matches the socket’s real path, so `/tmp/x` and `/private/tmp/x` are the same. `/private/var/run/mDNSResponder` (DNS) and `/private/var/run/syslog` are always allowed: without the first, name lookups fail. TCP, including loopback, is unchanged. Sockets in the shared `/private/tmp`, such as tmux’s, are closed.
- **Linux.** `bwrap` can’t filter sockets by path. Before each start, Ted reads `/proc/net/unix`, which lists every bound socket path, resolves each to its real path, and covers each socket file outside the Task’s writable folders and the list with `--ro-bind /dev/null <path>`, after the Task’s folders are bound, so connecting there fails. That includes sockets inside the Task’s read-only clones, since a read-only mount doesn’t stop a connect. Sockets under `/tmp`, `XDG_RUNTIME_DIR` and the hidden rest of `TED_HOME` are already out of reach and are skipped. A listed socket under `/tmp` or `XDG_RUNTIME_DIR`, where ssh-agent usually lives, is bound back read-only at its real path, when no part of that path is a link. If Ted can’t read `/proc/net/unix`, it refuses to start the command and raises `sandbox-unavailable`.

**Linux binds folders by descriptor.** When `bwrap --help` lists `--bind-fd`, Ted opens each folder it binds (`O_DIRECTORY | O_NOFOLLOW`), walks its path again without following links and compares the device and inode with the open folder, then passes the descriptors to `bwrap` as `--bind-fd` / `--ro-bind-fd`, starting at fd 3. A link swapped in afterwards can’t redirect the bind; `bwrap` itself checks the mounted folder against the descriptor and closes it before running the command. `Sandbox.wrap` returns the descriptors and a `close`; `runWorktreeCommand` passes them in `stdio`, and an App host gets their count as `bindFds` in `launch.json` and passes them on to the App. When `bwrap` has no `--bind-fd`, Ted uses ADR 0091’s path check and logs once that it did.

**Linux manual checks stay with KRI-179.**

## Considered Options

- **Leave sockets open and document it.** Rejected by the human: Docker and ssh-agent run code outside the sandbox on request.
- **On Linux, cover `/run` and `/var/run` with an empty tmpfs.** Rejected: it misses sockets in the home folder (`~/.docker/run`, Colima) and hides `/run/systemd/resolve`, which DNS reads.
- **A seccomp filter on `socket(AF_UNIX)`.** Rejected: it also blocks the Task’s own sockets, and `bwrap` needs a compiled filter.
- **Cut the network on Linux** (`--unshare-net`) to close abstract-namespace sockets. Rejected: Apps and tests need loopback and package registries.

## Consequences

- A Check or App that uses Docker, ssh-agent, a database on a Unix socket or another local service fails until the Factory lists that socket. Listing it opens that service to the Task’s code again, with the same risk as before.
- Remaining risk: on Linux, abstract-namespace sockets (names starting with `@` in `/proc/net/unix`, such as X11’s and some D-Bus buses) stay reachable, because only cutting the network closes them.
- Remaining risk: on Linux, a socket bound with a relative name shows in `/proc/net/unix` without its folder, so Ted can’t find and cover it.
- Remaining risk: on Linux, a listed socket under `/tmp` or `XDG_RUNTIME_DIR` is bound back by path. A process that can write its folder could swap it for a link between Ted’s check and `bwrap`’s start; list such sockets only when the Factory needs them.
- Remaining risk: on Linux, a socket created after the command starts (a Docker daemon restarting) isn’t covered. A socket removed between Ted’s read and `bwrap`’s start makes that start fail.
- Remaining risk: on Linux with a `bwrap` older than `--bind-fd`, the race in ADR 0091 stays.
- Linux is still untested here: the socket masks and descriptor binds join the manual checks in KRI-179.
