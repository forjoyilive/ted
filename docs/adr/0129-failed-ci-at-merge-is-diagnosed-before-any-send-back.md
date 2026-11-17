# Failed CI at Merge is diagnosed before any send-back

At Merge, Ted sent a Task back to Work whenever a GitHub CI check failed (ADR 0056). When the failure had nothing to do with the Task, such as a flaky job or a broken base branch, the Task went through Work, Validate and a new sign-off and failed again. Failure cases already let the Task Lead diagnose a failed local Check and ask the user (ADR 0095), at Merge too for the Checks Ted reruns after a rebase.

**Ted records a Failure case per failed CI check and keeps the Task in Merge.** It waits until no check that counts is still running, so the Task Lead looks at every failure together. The Task Lead assesses each case. A regression goes back through Work, Validate and re-sign-off as before. An unrelated or uncertain failure goes to the user as the existing failure decision: Retry, Fix in this Task, Wait for a repair Task, Accept this failure.

**A decision covers one attempt of one check on one commit.** The case is keyed by repo, pull request, head and the attempt identity the poller reads. A later attempt that passes closes the case; one that fails is a new case; a new commit closes the old case without a pass and CI is looked at afresh. An acceptance stays valid while the Task’s code is unchanged and that attempt is still the failed one; another check changing state doesn’t end it (`sameTestedFor` in `tasks/failure-cases.ts`).

**Ted never starts or reruns CI.** Retry means the user or GitHub reruns the job and the existing poller sees the new attempt.

**Acceptance changes only Ted’s own rule.** An accepted attempt no longer counts as failed CI for Ted, and GitHub’s merge state decides the rest. If GitHub still blocks the merge, the Task waits, says what must change and never merges.

**What reaches the Task Lead is bounded as before.** For the repo’s own Actions jobs and the CI services Ted trusts: the cleaned check name, result, link and log tail, inside a nonce fence (ADR 0065). For an outside app: only that a check failed, with the pull request link.

The steps are chosen by the pure `ciFailureSteps` in `tasks/ci-failures.ts`; `reconcileCi` in `tasks/tasks.ts` carries them out under the Task’s lock. Details are in `docs/spec/failure-cases.md`.

## Considered Options

- **Let the Task Lead record CI cases itself with `ted failure record`.** Rejected: Ted would still have to hold the merge and deduplicate across polls and restarts, and the evidence would be the agent’s report rather than Ted’s read.
- **Keep the whole-CI comparison for acceptance.** Rejected: every rerun of another job would end the acceptance and ask the user again.
- **Record a case as soon as one check fails.** Rejected by the user in Clarify: questions would arrive one after another while other jobs finish.
- **Diagnose CI failures in Validate and Review too.** Not done: there Ted only tells the Task Lead, who already decides.
- **Diagnose non-required failures in a repo that has required checks.** Not done: they don’t block the merge today.

## Consequences

- A check GitHub reports without an attempt identity, or a truncated check list, can’t be scoped, so that failure keeps the old send-back.
- After Retry, if nobody reruns the job, the Task stays at Merge showing “Waiting for a CI rerun on GitHub”. The Task Lead can assess again and ask again.
- A CI case that Ted closed because the commit changed or the Task left Merge is not a pass; the new commit’s CI must pass or be decided on its own.
