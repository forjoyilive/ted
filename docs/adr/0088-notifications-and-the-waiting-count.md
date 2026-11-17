# Notifications from the app, one waiting count from the daemon

Status: accepted (KRI-117)

## Context

Spec 3.8 asks for one notification per new Inbox item, folding of more than 3 within a minute, a notification when a stops-work problem starts, an optional one when a Task merges, and a sound switch. It also says the sidebar Inbox count, the Dock badge and the menu-bar count all show the number of waiting requests, read or not. Spec 2.1 puts notifications in the app process. Spec 2.4 says to ask for notification permission when the first Inbox item arrives.

Before this, the menu bar, tray and window title used `activity().waitingOnYou`, which counted Runs in `waiting` (including Runs paused by a problem) plus Automation questions and planning chat requests. It missed FAILED and idle asks, requests on Stopped Tasks and Ted’s own sign-offs, counted a Task with several requests once, and counted an Automation question twice. The sidebar added three renderer lists instead.

## Decision

- **One count, in the daemon.** `TedStore.waiting()` lists the requests the Inbox shows: every unanswered non-note Comment of a Task that isn’t archived, every unanswered Automation question of a Factory that exists, and every unanswered round or proposal of a planning chat of a Factory that exists, oldest first. Each entry carries what a notification needs (`WaitingRequest` in `packages/protocol/src/waiting.ts`). `GET /inbox/waiting` returns it, and after every commit that changes it the store emits `inbox-changed` with the list. The sidebar, the Settings back link, the Dock badge (Linux: `setBadgeCount`), the menu-bar title, the tray tooltip and the Linux window title all use its length.
- `Activity` drops `waitingOnYou`. It keeps only what the quit dialog and Stay Awake need (ADR 0028, ADR 0038).
- **Notifications in the app.** `packages/app/src/notifications.ts` decides what to show: a request it hasn’t seen since it connected, a stops-work `banner-raised`, and a Task’s first move to merged Done. Each kind has its machine setting (`notifyInboxItems`, `notifyProblems`, `notifyTaskMerged`), and `notifySound` sets whether they play a sound. The texts and what a click opens are plain functions in `background.ts`.
- **Folding.** Up to 3 notifications within a sliding minute show one by one. The 4th closes them and shows “4 new items in your Inbox”, which opens the Inbox; each further one within the minute replaces it with a higher count.
- **Permission.** On macOS nothing notifies until the first new Inbox item arrives, whose notification is the one that makes macOS ask. With Inbox items off, that first item shows nothing but lets the other kinds notify from then on. `asked` and whether the OS refused (a notification’s `failed` event, or `Notification.isSupported()` false) are kept in `notifications.json` in the app’s user data folder. A refusal shows the red row on Settings → Notifications and a red dot on its section; the next notification that shows clears it.
- **Tests never reach the OS.** `TED_NOTIFY_LOG` makes the app write each notification, close and badge change to a file instead, and `TED_NOTIFY_STATUS=off` makes every notification count as refused. With `TED_HIDDEN_WINDOW=1` and no log, nothing is shown and the Dock isn’t touched.

## Considered Options

- **Keep counting in the renderer.** The main process has no renderer state when the window is closed, and the badge must be right with no window.
- **A count on `Activity`.** Mixes what the human must answer with what keeps Ted running; the quit dialog and Stay Awake would recompute on every Comment.
- **Hold the first notifications for a minute and send one summary.** Delays the first notice, which is the one that matters.

## Consequences

- Whether macOS asks for permission at the first Inbox item, whether a refusal fires `failed`, the Dock badge, the sound, and what clicking a notification opens need a manual check on a real Mac and Linux desktop (KRI-179).
- Requests that arrive while the app isn’t connected don’t notify when it reconnects; they are already in the count.
