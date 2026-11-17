# Idle sub-agents and chats sleep too, and sooner while the computer is busy

Status: accepted (TED-548). Amends ADR 0172-an-idle-task-leads-agent-is-ended-and-started-again-on-the-next-message.

On 2026-11-16 one Run of six was working, six Task Leads were asleep, and four Runs still had a live `claude` process with about 44 MCP servers: about 4.8 GB on a 36 GB Mac that was paging, while 12 queued Tasks waited for the busy hold to lift. ADR 0172 ended only idle Task Leads. The event log shows what stayed up: sub-agents idle for most of an hour, each ending at the same second as its Lead; Coordinator chats up 5 and 6 hours; and Leads kept awake by their idle sub-agents, because `maySleep` counted any live sub-agent.

**Four kinds of Run sleep.** `sleepKind` in `runs/idle-sleep.ts` names the kinds: a Task Lead (a Task Run with no parent), a sub-agent (a Task Run with a parent), and a chat (the current Run of a Coordinator chat, or a planning chat’s Run). Side chats, Automation Runs and drafts, and Runs started outside a Task through `/dev/runs` still never sleep. `maySleep` keeps ADR 0172’s shared rules (idle, no `problem`, a session, Claude Code or Codex, quiet for the idle time, no queued Run message) and adds one rule per kind:

- **Task Lead:** as in ADR 0172, except that only a sub-agent that isn’t idle keeps it awake. An idle or sleeping sub-agent no longer does.
- **Sub-agent:** its parent Run hasn’t finished and its Task isn’t archived, stopped, in Backlog or Done. The Task’s `midWork` doesn’t apply: a sibling working or a Check running is no reason to keep an idle sub-agent’s agent. A reviewer that has given its final message may sleep; its report is read from the store.
- **Chat:** the owner says the chat may rest. `Coordinators.mayRest` allows a chat whose current Run this is, in phase `ready`, with no launch, stop, removal or change under way and no queued message. `Plans.mayRest` allows a `started` plan that isn’t waiting to be resumed; a plan waiting on a round or proposal may sleep, because the answer reaches it as a message.

**Waking needs no new path.** A message reaches a sub-agent through `RunManager.send` (`ted run send`) and a chat through `send` or `dispatch`, which wake a sleeping Run as in ADR 0172. Waking a Lead doesn’t wake its sub-agents. `ted run wait` waits for the woken sub-agent’s next answer as before, and stopping a sleeping sub-agent or its Task ends it without starting anything.

**Each kind rebuilds its environment.** After a daemon restart a wake asks `RunManager.envSource`, which `daemon.ts` now builds per kind: `Tasks.runEnv` for Task Runs (the Lead’s environment as before, and for a sub-agent the same `envFor(task, repo)` with `TED_TASK` it was started with), `Coordinators.runEnv` (`TED_CHAT`, `TED_FACTORY`) and `Plans.runEnv` (the first repo’s environment, `TED_PLAN`, `TED_FACTORY`). Only kinds with a source can sleep, so no Run is ended that can’t be started again with its own environment.

**Markers.** At daemon start `asleep.json` counts for any idle Run with a session whose `sleepKind` is set, not only a Task Lead.

**Sooner while the computer is busy.** While the busy hold of ADR 0166 is on (`store.busyHold()`), the idle time is 2 minutes, or the setting if that is shorter (`sleepAfterMs`). That hold means new work is waiting for room, so a waiting agent should give its memory back quickly. A wake is still allowed under the busy hold. The full-disk hold (`newWorkHold`) still stops sleep and wake, as in ADR 0172. With the setting off (`null`), nothing sleeps, busy or not.

**Banner.** `run-wake-failed` names what couldn’t start: the Task Lead, the sub-agent by name, or the Coordinator or planning chat by title. Only Task Runs get the Open Task action, since a banner can’t open a chat.

**Setting.** The switch in Settings → Limits is now **End idle agents to free memory**.

## Consequences

- A sub-agent the Lead asks again after the idle time answers a few seconds later, while its agent starts again.
- A Coordinator or planning chat the user comes back to after the idle time takes a few seconds before its first reply.
- Under the busy hold an agent quiet for 2 minutes restarts on its next message, which costs a few seconds and a session reload.

## Considered Options

- **End a sub-agent as soon as it gives its final message.** Rejected: Leads often send a follow-up within minutes, and each one would pay a restart.
- **Keep the Task’s `midWork` for sub-agents.** Rejected: it holds an idle sub-agent awake for as long as a sibling works or a Check runs, which is the case this ADR is about.
- **Let a wake read `env.json` for kinds with no source.** Rejected for the reason in ADR 0172: a wake takes nothing from the Run folder on trust.
