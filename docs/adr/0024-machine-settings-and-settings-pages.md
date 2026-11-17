# Machine settings as one event, and Settings pages in a registry

Status: accepted (KRI-94)

## Context

Spec 11.2 lists many machine settings: Appearance, terminal font size, profile picture, Developer mode now, and limits, login, Stay Awake, editor, notifications and billing in later tickets. KRI-87 stored Appearance with its own event, `v1.AppearanceChanged`, and a one-column `machineSettings` table. A new event and a new column per setting would make every later ticket touch the store schema. Spec 11.3 also lists eight Settings sections that later tickets fill one at a time.

## Decision

- Every machine setting change is one `v1.MachineSettingsChanged` event carrying the changed values as JSON. It materializes into `machineSettingValues` (one row per setting name). `TedStore.settings()` starts from `defaultMachineSettings` in `@ted/protocol`, applies the old `v1.AppearanceChanged` row, then the new rows. `v1.AppearanceChanged` stays for stores that already hold it, and is no longer emitted.
- The daemon validates each setting in `settingParsers` in `server.ts`. A new setting is a field and default in `packages/protocol/src/settings.ts` plus a parser; no new event.
- The profile picture is a PNG data URL of at most 256 by 256 pixels, made by the app’s main process from the file the human picks, and stored with the other settings (at most 512 KB). The renderer’s CSP allows `img-src data:` for it. Initials come from `GET /profile`, which reads the global Git `user.name`.
- App Settings is a navigation overlay (`Navigation.settings`), so closing it returns to the exact screen and Task the human left. Its sections are listed in `settingsSections` in `packages/app/src/renderer/settings/sections.tsx`; a section without a `Page` shows “Not built yet.” A new page is a component that takes `SettingsPageProps` and uses the shared controls in `settings/controls.tsx`.
- Diagnostics, the daemon log and a Run’s raw output come from the daemon (`GET /diagnostics`, `/diagnostics/report`, `/logs/daemon`, `/runs/<id>/raw`), all closed to Run tokens. Logs are read from the end, 256 KB at most. The report replaces the Ted home folder and the user’s home folder in paths and never includes prompts or raw output. It goes only to the clipboard.

## Consequences

- Settings changes are cheap to add, but the event no longer says which setting changed in its name; readers must look at its JSON.
- The log viewer shows the daemon’s log file, not LiveStore’s internal eventlog, because LiveStore has no supported way to read the eventlog without a sync backend.
