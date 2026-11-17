# A multi-repo Task merges in `repos` order, and a failure partway shows Partly merged

A Task with pull requests in several repos merges them one by one (spec 9.9 rule 8). The merge watcher in `packages/daemon/src/tasks/merge-watcher.ts` (ADR 0056-ted-merges-pull-requests-at-the-merge-stage) consumes the poller’s read of every open pull request and merges only when every one is ready; this ADR adds the order, the failure partway and what “merged” means for blockers.

**Order.** `mergeTargets` sorts the Task’s open pull requests by the Factory’s `repos` order from `factoryRepos`, not by the order the Task gained its repos. A repo no longer listed goes last. Each pull request keeps its own repo’s CI detection (from its push) and `merge_method`.

**All green first.** Each cycle checks every open pull request before merging any: one that waits for CI, a review or GitHub sign-in holds them all, and one that fails CI, conflicts or changed after sign-off sends the Task back before anything merges. Ted turns on GitHub’s auto-merge only when the Task has a single open pull request, because auto-merge on one of several would let GitHub merge it while another is still red.

**Failure partway.** Merges then run in order with `--match-head-commit`. If a merge command fails after an earlier pull request of the Task merged (in this cycle or an earlier one), Ted reads that pull request again; if GitHub merged it after all, Ted records it and carries on. Otherwise the Task goes back to Work with the `gh` error. Any send-back from Merge while some pull requests have merged and others haven’t records `v1.MergeStoppedPartway` (the repo names on each side) once, sets the Task’s `partlyMergedAt`, posts the thread line “Merge stopped partway · widgets merged, api didn’t. Ted doesn’t revert a merged pull request.” and adds to the Findings which repos already merged and that only the rest needs fixing. A failure of the first merge, with nothing merged, keeps ADR 0056’s behaviour: Ted logs it and tries again next cycle.

**Partly merged.** The status shows while `partlyMergedAt` is set, the Task isn’t Done, and its live repos have both a merged and an unmerged pull request. It ranks second, after Failed, so it stays on through Work, Validate and the re-sign-off. The activity line reads “widgets merged · api not yet” unless the agent has set its own. The fix runs through the usual path: merged repos are never pushed again, the new sign-off records commits only for the unmerged pull requests, and the next Merge visit merges only those. When the last one merges the Task moves to Done and the status ends.

**Merged for blockers** stays `TedStore.isMerged`: Done and every pull request merged. A Partly merged Task is never Done, so Tasks it blocks stay blocked until the rest merges.

Ted never reverts a merged pull request.

## Considered Options

- **Derive Partly merged from the pull requests alone (some merged, some not).** Rejected: between two merges of one successful cycle, and when the human merges one on GitHub while another still waits for CI, the Task would flash a red status that isn’t a failure.
- **Retry a failed merge partway, as for the first merge.** Rejected: the spec sends the rest through Work, Validate and a short re-sign-off, and a pull request that GitHub refuses to merge needs a person or the Task Lead to look at it.
- **Keep auto-merge for every pull request.** Rejected for the reason above; a single-repo Task keeps it.

## Consequences

- The Merge Gate (ADR 0062-merge-gate-merge-off-re-sign-off-and-ci-stuck) is posted only once every open pull request is ready, so its rows follow the same `repos` order; auto-merge stays off with a Merge Gate, as there.
- A pull request auto-merge was turned on for while the Task had one repo keeps it if a second repo is added later; GitHub may then merge it before the other is green.
