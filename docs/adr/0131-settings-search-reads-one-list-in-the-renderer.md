# Settings search reads one list in the renderer

App Settings has nine pages and each Factory has its own settings screen, so the human had to know which page holds “Autopilot” or “Keep Run output”. A search field at the top of the App Settings sidebar and of the Factory settings left column, and a Settings group in ⌘K, now find a setting by name and open it (KRI-352).

- **One list.** `packages/app/src/renderer/settings-search.ts` lists every fixed setting and every section and group heading under an id: `app.<page>.<group>.<row>` or `factory.<section>.<group>.<row>`. An entry holds the name and, where the text is fixed, the help and detail lines. `findSettings` matches the query against the name, the group, the page and those lines with `searchTerms` and `matchesTerms`, the matching ⌘K uses for commands. A name match comes first, a setting before a heading. An entry can carry `keywords` for a name the setting used to have: “overnight” still finds Autopilot.
- **Rows carry the id.** `SettingRow` and `SettingsGroup` take `setting` and read their title, help and detail from the list, so the page and the search can’t show different names. Factory settings rows and headings are their own markup and carry the id as `data-setting`. `settings-search.test.ts` fails when an id in the list is on no row.
- **What isn’t listed.** Rows that depend on data: Library Stage files, Storage worktrees and backups, the per-Factory rows on Agents and Integrations, and a Factory’s Stages, Checks, Apps and repos. Searching “Clarify sign-off” finds the Workflow section, not the Clarify row.
- **Which Factory.** The one the human is in or was last in (`currentFactoryId`), else the first; never every Factory. A result reads “Settings › General” or “<Factory> › Settings › Workflow”.
- **Opening one.** `openSetting` in `setting-focus.ts` remembers the id for four seconds and dispatches the existing navigation action. `useShownSetting`, used by `SettingsShell` and `FactorySettings`, waits for the element with that `data-setting` (Factory settings load after the screen opens), scrolls it to the middle and sets `data-found`, which `base.css` animates with the accent tokens.
- **Keys.** While the field has text the results take the place of the page list; ↑ and ↓ move, Enter opens, Esc clears the field first. The field is a `data-filter-box`, so `/` focuses it; `filter` is now allowed while Settings is open.

## Considered Options

- **Build the list from the rendered pages.** Only the open page is rendered, and most pages load their data first, so a search would miss everything not yet shown.
- **Put the setting to show in the navigation state.** It would enter the back and forward history and highlight again on Back.
- **A floating results list.** It would cover the settings in a narrow sidebar.

## Consequences

- A new fixed setting needs an entry in the list and `setting` on its row; a row without an entry can’t be found.
- A row that shows only in some states (Sync status with Linear needs a key) may be absent when chosen. The page opens and, after four seconds, its group heading is marked instead.
- The Validate round settings and “Task Lead closes its own fixed failures” are listed only under Factory settings, though the Library page draws the same rows.
