# Queued Tasks keep their place, and the sidebar says the computer is busy

Status: accepted (TED-638). Amends ADR 0192-cleanup-skips-the-busy-hold-and-queued-labels-say-only-why.

ADR 0192 made a queued Task read “Queued · computer is busy” while the busy hold stopped it. With many Tasks queued behind the hold, every one read the same, and the user lost the order they would start in.

**A queued Task always shows its place.** `taskStatus` in `tasks/status.ts` returns `{ kind: 'queued', place }` whether or not the busy hold stops it; `TaskStatus` no longer carries `busy`. Other holds (a full disk, a Provider turned off, Waiting for a Provider) still replace the place with their reason. `TaskFacts.busy` stays: comment delivery and the Task’s wait reasons still read it, and their text is unchanged.

**One strip in the sidebar says the computer is busy.** While `GET /slots` carries `busy`, the sidebar shows “Computer is busy · new work waits” as an amber strip just above usage. Hovering shows `busyDetail` (each resource’s figure and its marks); clicking opens Settings → Limits. The Runs line drops its “· computer is busy” suffix; the “Now:” line on Settings → Limits keeps it.

## Considered Options

- **A pill under the Runs line, or a gauge icon with a dot.** The user chose the full-width strip, placed above usage.
- **Changing the queued sub-agent hold.** Its text reaches only the Task’s wait reasons, which keep “computer is busy”, so nothing changed there.
