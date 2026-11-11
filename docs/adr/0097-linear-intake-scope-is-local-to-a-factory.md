# Linear intake scope is local to a Factory

Status: accepted (KRI-231)

A Factory may select Unscoped, one Linear Team, or one Linear Project. These are alternatives. Existing Factories default to Unscoped. The scope narrows automatic intake; it leaves existing Tasks, manual imports and Linear status-sync consent (ADR 0090) unchanged. The built-in Linear Automation still looks for issues assigned to the human that have not started.

The human saves this choice immediately in Factory settings → Linear intake. `linearIntakeScopes` is a machine setting keyed by Factory ID, recorded through `v1.MachineSettingsChanged`. Each entry holds the kind, target ID, display name and workspace ID and URL key; an absent entry means Unscoped. Removing the Factory removes its entry. No `.ted/` file controls it.

`PUT /factories/:id/linear-intake` is app-only. It verifies the selected target against the connected workspace and updates just that Factory in the latest settings map. Unscoped needs no Linear connection. Team and Project choices are paginated reads through `linear/linear.ts`; the renderer and agents never receive the key. Loading, empty, inaccessible and failed states retain the saved scope.

Every Automation prompt includes the current scope, including custom Automations and those saved before this setting existed. The Tasks module additionally enforces scope before committing any Automation-created Task or Follow-up. It reads fresh issue membership and workspace identity through the Linear boundary, compares stable IDs, and refuses an unverifiable or out-of-scope issue. It also checks that the local scope has not changed during preparation. A Project may include issues in several Teams; a Team includes its issues regardless of Project. Non-Linear sources are unaffected. Unscoped and manual imports retain their existing link-only fallback when Linear cannot be read.

The prompt helps the Automation search efficiently; it is not the enforcement boundary. Matching names, trusting an agent’s metadata, or reusing cached Task source data could import the wrong issue. Tests use stub Linear responses and never a live workspace.
