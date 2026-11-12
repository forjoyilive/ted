# Each Factory chooses its notifications, and a quiet Factory leaves the Inbox count

Notifications were app-wide only (ADR 0088), so a busy Factory and a quiet one notified the same way. The human wants to choose per Factory, from the Factory’s own Settings page and from Settings → Notifications (KRI-355).

- **One machine setting.** `factoryNotifications` maps a Factory ID to `{ inboxItems, taskMerged }`. A Factory with no entry reads as Inbox items on and Task merged off, through `factoryNotifications(settings, factoryId)` in `packages/protocol/src/settings.ts`. Removing a Factory drops its entry.
- **Two places, one setting.** The Factory’s Settings page has a Notifications section, and Settings → Notifications has a By Factory table. Both write the same map with `updateSettings`.
- **The app-wide switches stay.** A notification is sent only when its app-wide switch (`notifyInboxItems`, `notifyTaskMerged`) and the Factory’s choice are both on. Problems that stop work and the sound stay app-wide.
- **A quiet Factory leaves the count.** `TedStore.waiting()` still returns every open request and marks those of a Factory with Inbox items off as `uncounted`. `countWaiting` in `packages/protocol/src/waiting.ts` counts the rest, and the sidebar Inbox count, the Dock badge, the menu-bar count and the Linux window title use it. The requests stay in the Inbox list, each marked “Not counted”, with a note at the top that names the Factory.
- **The app-wide Inbox items switch does not change the count**, as before.
- **First open after the update.** When `factoryNotifications` has never been saved and the home has Factories, the store saves it once: with the app-wide Task merged switch on, every existing Factory gets Task merged on.

## Considered Options

- **`waiting()` leaves a quiet Factory’s requests out.** Every count would follow with no helper, but the app’s notifier would see those requests as new when the Factory is turned back on and send one notification each. With the mark, the notifier has seen them and stays silent.
- **Copy the app-wide Inbox items switch to existing Factories too.** A human who had it off would find the Inbox count at zero after the update, because a Factory’s Inbox items choice also decides the count. The app-wide switch still silences those notifications, so existing Factories start with Inbox items on.
- **A bell in the header of the Board and List.** Designed first; the human moved the choices to the Factory’s Settings page.

## Consequences

- Anything new that shows how many requests wait uses `countWaiting`, never the list’s length.
- Turning Inbox items back on for a Factory sends nothing for the requests already waiting.
- The setting is per machine, like the other notification settings.
