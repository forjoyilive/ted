# TED v1: designed and undesigned screens

Sources: the Figma file `SLTyztzQXHFdz4sk3TcePk` (one page, “Page 1”, node `0:1`), the map KRI-8 and the resolution comments on KRI-10 to KRI-23 and KRI-52. Read on 2026-11-08.

## Exists

All five frames are on Page 1. All are final picks. No rejected alternatives are in Figma: the rejected layouts (KRI-13 B and C, KRI-23 B and C) exist only in the prototype branches `prototype/kri-13-inbox-and-thread` and `prototype/kri-23-apps-section`.

| # | Frame | Node | What it shows | Status | Ticket |
|---|---|---|---|---|---|
| 1 | Inbox · three panes (KRI-13) | [4:2](https://www.figma.com/design/SLTyztzQXHFdz4sk3TcePk/TED?node-id=4-2) | Sidebar (Factory switcher “Notebook”, Inbox with count, Board, List, Factories list, footer “4 Tasks working · 1 failed”). Inbox list with three rows: Question, Design review, Sign-off. Task thread for a Task in Clarify: header (ID, “Created by you”, title, “Waiting on you” status, Stage track, activity line), events, a Task Lead Comment, and the open **Question** pinned at the bottom with three choice buttons and a text box with Send. Task details: Stage history (past with time spent, current, future greyed), Task brief as a paragraph, Code (two repos, “No pull request yet”), Runs (Task Lead · Claude · idle). | Final (layout A) | KRI-13 |
| 2 | Apps section · Task details (KRI-23) | [13:3](https://www.figma.com/design/SLTyztzQXHFdz4sk3TcePk/TED?node-id=13-3) | Same shell, Task at Review. **Sign-off card**: title, summary, ✓ checks row (typecheck, unit, e2e, lint), three screenshot tiles, “How to try it”, Preview row with Open, comment box, Request changes and Approve and merge below the box. Task details: Code with one PR per repo, **Apps** grouped by repo (Web running, iPhone shut down to free a slot, Vercel preview hosted, API running) with ↗ ■ ▶ ↻ buttons and a simulator-limit note, Task brief as Goal + Next step + Full brief button. Sidebar footer “Simulators 3 of 3 booted”. Stage history and Runs are not in this column. | Final | KRI-23 |
| 3 | App log in the middle pane (KRI-23) | [14:2](https://www.figma.com/design/SLTyztzQXHFdz4sk3TcePk/TED?node-id=14-2) | The Web App’s log replaces the thread: “← Thread” link, header with status, repo, URL, Preview / Stop / Restart, dark log body. Web row highlighted in Apps. | Final | KRI-23 |
| 4 | Full brief in the middle pane (KRI-23) | [14:204](https://www.figma.com/design/SLTyztzQXHFdz4sk3TcePk/TED?node-id=14-204) | The whole Task brief replaces the thread: Goal, Decisions so far, Current state, Open questions, Next step, “Updated by the Task Lead at the Review Gate · 31m ago”. | Final | KRI-23 (brief headings from KRI-17) |
| 5 | Run iPhone with all simulators booted (KRI-23) | [14:404](https://www.figma.com/design/SLTyztzQXHFdz4sk3TcePk/TED?node-id=14-404) | Popover over the sign-off view: “All 3 simulators are booted”, radio list of booted simulators by Task with “used … ago”, oldest selected, Cancel and “Shut down NB-40’s and run”. | Final | KRI-23 |

Notes on the existing frames:
- Frame 1 predates two KRI-23 rules: request buttons go below the comment box (frame 1 has Send inside it), and the brief shows Goal + Next step + Full brief (frame 1 shows a paragraph). Frame 1 also uses placeholder colours (KRI-13), and KRI-23 asked for higher contrast on secondary text and lines.
- Only light mode exists. Only the Question and Sign-off request cards are drawn; Design review appears only as an Inbox row.

## Needed, not designed

Priority: **core** = needed to build the main loop (create a Task, watch it move, answer, sign off, merge); **secondary** = a v1 feature outside the main loop; **edge** = a state of something else.

### 1. App shell and navigation
1. **Sidebar, full version**: Factory switcher menu, per-Factory entries for Plans and Automations, Add Factory, Settings, Developer mode entry, footer variants (working count, failed, queued, simulators). KRI-13, KRI-19, KRI-20. *Core.*
2. **Command palette** over Tasks, Comments and commands. KRI-20. *Secondary.*
3. **Dark mode** of every screen (light, dark, follow system). KRI-20, KRI-23. *Secondary.*
4. **Linux window chrome and tray** variants. KRI-10, KRI-11. *Edge.*

### 2. Inbox list
5. **Inbox row kinds not yet drawn**: Clarify round (“Clarify · Round 2 · 4 questions”), permission request, Automation Comment under the Automation’s name, Planning Run round and sign-off, Validate loop ask, re-sign-off. KRI-19, KRI-20, KRI-16, KRI-52. *Core.*
6. **Read and unread rows**, and the row after it is answered (leaves the list). KRI-11. *Secondary.*
7. **Empty Inbox**. *Secondary.*

### 3. Request cards (pinned at the bottom of the thread)
8. **Design review card**: screenshots, video, embedded interactive prototype, Figma link, Approve / Request changes. KRI-13. *Core.*
9. **Clarify round card**: several questions, each with its recommended answer pre-filled, optional choice buttons and a text box; Accept all recommended; Talk it through. KRI-19. *Core.*
10. **Talk it through**: live chat with the Task Lead on an unanswered round, ending in a summary Comment. KRI-19. *Secondary.*
11. **Grilling sign-off card**: summary of decisions, Approve / Request changes (starts another round). KRI-19. *Core.*
12. **Size check question**: Plan in chat / Split it / Plan it outside TED / Grill anyway. KRI-19. *Secondary.*
13. **Split proposal sign-off**: list of pieces (title, one-line scope, blocking links). KRI-19. *Secondary.*
14. **Permission request card**: Approve / Deny, shown in the thread, the Inbox and as a row in the Run chat; the Run shows as waiting. KRI-20. *Core.*
15. **Validate loop ask**: each round’s blocking Findings, Try again / Back to Design / Move to Review anyway, text box. KRI-16. *Secondary.*
16. **Re-sign-off** showing only “Changes since you approved”. KRI-52. *Secondary.*
17. **Merge over `max_back`** question to the human. KRI-52. *Edge.*
18. **Agent needs a simulator, all slots booted**: an Inbox Comment like a permission request (KRI-8 fog, “left for the spec”). KRI-23, KRI-8. *Edge.*
19. **Request changes with diff line comments** drafted in the Changes panel and sent together. KRI-18. *Secondary.*
20. **Answered request in the thread**: what a card turns into after Approve or an answer (“You approved · Task moved to Design”). KRI-11. *Core.*
21. **Plain comment box** when nothing is waiting. KRI-13. *Core.*

### 4. Task thread and header
22. **Event lines**: Validate event with the ✓ checks row (click to expand output, “✓ Review · 2 notes”); “Validate sent this back to Work (round n of 5)” with Findings; Clarify depth pick; App restarts; merge-method fallback note; Stage file/layer used. KRI-16, KRI-19, KRI-12, KRI-18, KRI-52. *Core.*
23. **Task statuses in the header** (and on cards): Working, Waiting on you (drawn), Idle, Queued, Failed, Done, plus Blocked (naming the blocker), Needs planning, Waiting for merge, Partly merged, Waiting for GitHub review. KRI-11, KRI-15, KRI-19, KRI-52. *Core.*
24. **Attachments in Comments**: images, HTML in a sandboxed frame. KRI-20. *Secondary.*
25. **Task actions menu**: Start, un-start, Stop, Archive, Unarchive, Delete, Follow up, set Priority, set Clarify depth. KRI-11, KRI-15, KRI-19, KRI-52. *Core.*
26. **Delete confirm dialog** (removes Task, Runs, transcripts; leaves branch and PR). KRI-11. *Secondary.*
27. **Archived Task view** (read-only, Unarchive). KRI-11. *Secondary.*
28. **Done Task**: Follow up action, and the Follow up offer when typing a Comment on a Done Task. KRI-52. *Secondary.*
29. **Comment after sign-off cancels the pending merge** (warning before sending). KRI-52. *Edge.*
30. **Failed Task** state and what the human can do about it. KRI-11. *Edge.*

### 5. Task details column
31. **Runs section, full**: one row per Run (Task Lead first, sub-agents, “+N”), working / idle / stopped / failed, Stop on a sub-agent, Restart, which credential the Run uses. KRI-11, KRI-20, KRI-21. *Core.*
32. **Changes section**: changed files with +/− counts grouped by repo. KRI-20. *Core.*
33. **Diff in the middle pane**, with line comments and Open in editor. KRI-20, KRI-18. *Core.*
34. **Expand all**: details pane widened into one column of every diff with a sticky file index. KRI-20. *Secondary.*
35. **Task fields**: Priority, Clarify depth (Auto/None/Few/Grill), source URL, blocked-by and blocking links, Planning Run link, Follow-up link. KRI-15, KRI-19, KRI-20, KRI-52. *Secondary.*
36. **Original request** (collapsed) and description history. KRI-19. *Secondary.*
37. **Cost and tokens** per Run and per Task. KRI-20. *Secondary.*
38. **Code section PR states**: CI failing, conflicts, merged, partly merged. KRI-52. *Secondary.*
39. **Apps row states not drawn**: starting, “Exited with code 1”, a `command` App with no Preview; Apps hidden on Linux. KRI-23. *Edge.*
40. **Combined column**: one frame with Stage history, brief, Code, Changes, Apps and Runs together, and its scroll order (frames 1 and 2 each show part). KRI-13, KRI-23. *Core.*

### 6. Run Conversation (chat)
41. **Run chat in the middle pane**: streaming messages, collapsible tool-call rows, edits expandable to diffs, send and interrupt, permission request rows; opened from a Run row or a Conversation tab. KRI-20. *Core.*
42. **Thread / Conversation switch** in the middle pane. KRI-20. *Core.*
43. **Stopped Run** (read-only history) and the restart-onto-new-version event. KRI-11, KRI-20. *Secondary.*
44. **Per-Task shell** (one per worktree per repo, with search). KRI-20. *Secondary.*

### 7. Board
45. **Board**: columns Backlog → Intake → … → Merge → Done; cards with ID, title, Priority, Run icons, status, activity line, play button on Backlog cards, Queued cards at the top of Intake with “Queued · 2nd”, Blocked badge naming the blocker, Needs planning marker; clicking opens the Task with a back link. KRI-11, KRI-13, KRI-15, KRI-19. *Core.*
46. **Drag states**: valid drop column lit, others dimmed, not-allowed cursor; dropping among another Priority changes Priority. KRI-15. *Secondary.*
47. **Empty Board and empty columns**. *Edge.*

### 8. List
48. **List**: sortable, groupable, filterable rows, including Manual sort and a Needs planning filter. KRI-13, KRI-15, KRI-19. *Core.*
49. **Sort, group and filter menus**. *Secondary.*
50. **Empty List and no-results**. *Edge.*

### 9. Creating Tasks
51. **Create Task dialog**: title and description or a pasted Linear URL, Start now (on by default), Priority, Clarify depth, blocked-by. KRI-15, KRI-19, KRI-20. *Core.*
52. **Linear URL fetch**: loading, fetched (title, branch name), no API key, fetch failed. KRI-20. *Secondary.*
53. **Duplicate source**: the existing Task is returned instead. KRI-20. *Edge.*
54. **Setup notices on create or start**: “Setup isn’t finished…” (Start anyway / Open setup Task) and “This Factory hasn’t been set up” (Start anyway / New setup Task). KRI-22. *Secondary.*

### 10. Planning
55. **Plans list** per Factory: open and finished planning chats, status, Tasks created. KRI-19. *Secondary.*
56. **Planning chat** in the middle pane, with rounds and the Task proposal sign-off (Tasks with blocking links; Approve creates them in Backlog). KRI-19. *Secondary.* (KRI-8 leaves its visual detail to build.)
57. **Plan entry points**: Plan on the Factory, Plan in chat from a too-big Task. KRI-19. *Secondary.*

### 11. Factories: adding, setup, settings
58. **Add Factory form**: repo picker (first is primary), refusal when a repo is already another Factory’s primary, “also used by Factory X” note, clone and GitHub access check results, Show the tutorial checkbox. KRI-22. *Core.*
59. **Setup Task proposal** at the Design Gate: Checks and Apps each with pass/fail and duration, failures unticked with the reason, notes, Stage overrides, settings. KRI-22. *Core.*
60. **Tutorial Comments** posted as each Stage starts on the first Factory. KRI-22. *Secondary.*
61. **Later setup Task** proposing changes as a diff of current files. KRI-22. *Edge.*
62. **Factory settings panel**: Stages (order, on/off, Gate, `max_back`, Clarify depth, tagged Default/Library/Factory, Override for this Factory / Reset to inherited), Checks with Run now and a “No Checks” state, Apps, Factory notes Markdown editor, repos (including `merge_method`), `lead`, reviewer, permissions, `max_working_runs`, New setup Task, warning when the Review Gate is off. KRI-12, KRI-16, KRI-20, KRI-22, KRI-52. *Core.*
63. **Save flow**: Save and merge (default) / Save as pull request, pending and merged states. KRI-22, KRI-52. *Secondary.*
64. **Drift row**: “Inherited version changed”, diff, Keep mine / Use inherited / Merge with an agent. KRI-22. *Secondary.*
65. **Factory banner** suggesting a setup Task when `repos` changes or a Check’s command is missing (exit 127). KRI-22. *Edge.*
66. **“No Checks”** on the Validate row with a New setup Task link. KRI-22. *Edge.*

### 12. Automations
67. **Automations page** per Factory: list with schedule, last run, run history with retries. KRI-20. *Secondary.*
68. **Automation editor**: cron or RRULE with timezone, prompt, agent, model, effort; templates (Linear, Sentry, GitHub triage). KRI-20. *Secondary.*
69. **Automation Run view** (its chat and the Tasks it created). KRI-20. *Secondary.*

### 13. App settings
70. **TED Settings**: max working Runs (6), simulator cap (3), auto-restart idle Runs on new agent versions, Stay Awake, notification sound, theme, auto-update, Linear API key, reviewer default, Developer mode toggle, remembered quit choice. KRI-15, KRI-16, KRI-18, KRI-20, KRI-11. *Secondary.*
71. **Library editing** (Stage files and Workflow settings, TED defaults read-only). KRI-12, KRI-22. *Secondary.*
72. **Agent health**: Claude Code and Codex installed, signed in, version. KRI-20. *Core* (needed at first run).

### 14. Developer mode
73. **Diagnostics**: CPU and memory per Run, process table, memory pressure, token use per Run, Copy report. KRI-20, KRI-17. *Secondary.*
74. **Event log and raw Run output viewers**. KRI-20. *Secondary.*

### 15. System surfaces
75. **Menu-bar / tray menu**: unread count, open TED, Quit TED completely. KRI-11, KRI-20. *Secondary.*
76. **Quit dialog**: Keep running in the background (default, rememberable) / Stop them and quit / Cancel. KRI-11. *Secondary.*
77. **System notification** per new Inbox item, and the Dock badge. KRI-20. *Secondary.*
78. **OS permission asks** at the moment of need (notifications on first Inbox item; protected macOS folders when adding a repo from one). KRI-20. *Edge.*
79. **App update waiting** for Runs to finish before restarting the daemon. KRI-11. *Edge.*

### 16. First run and empty states
80. **First launch**: check `claude` and `codex` installed and signed in; open the CLI’s own login in a terminal when not. KRI-21, KRI-22. *Core.*
81. **No Factories yet** → Add Factory. *Core.*
82. **Empty Plans and Automations lists**. *Edge.*
83. **Daemon not reachable** or restarting. KRI-10, KRI-11. *Edge.*

Counts: 83 items. Core 26, secondary 41, edge 16.

## Needed but undecided

1. **Model and effort for a Run.** `lead` can name a model and Automations store model and effort, but how does the human pick model and effort for a Task’s Task Lead or a sub-agent, and can it change per Task?
2. **App settings layout.** What sections does TED Settings have, and how does Library editing work in the UI: a Stage file editor, or only Workflow settings?
3. **First-run sign-in.** How does TED show and fix a missing or signed-out `claude`/`codex` (embedded terminal, external terminal, instructions)? How does the user connect GitHub (rely on `gh auth`, or a token in the Keychain)? When is the Linear API key asked for?
4. **Credential mode per Run.** KRI-21 says show which credential each Run uses and strip API keys unless the user picked API-key mode. Where is that mode chosen, and where is it shown?
5. **Plan usage.** KRI-21 says to show plan usage because parallel Runs share one five-hour and weekly allowance. Where, and in what form?
6. **Scope of Inbox, Board and List.** Is the Inbox across all Factories or per Factory? Is there an all-Factories Board or List? The queue is machine-wide; where does the human see it and the working-Run limit?
7. **The Factory page.** KRI-22 puts a banner “on the Factory page”. What does clicking a Factory in the sidebar show: its Board, an overview, or settings?
8. **Archived Tasks.** Where do archived Tasks live and how does the human find and unarchive one?
9. **Failed Tasks.** What does Failed mean for a Task, and what can the human do: retry, restart the Task Lead, archive?
10. **Removing a Factory.** Can a Factory be removed or renamed, and what happens to its Tasks, worktrees and `.ted/` files?
11. **Per-Task shell placement.** Where does the shell open: middle pane, a tab beside Thread and Conversation, or a drawer?
12. **Opening a repo by hand.** “Open in editor” is decided; which editor, and is it a setting?
