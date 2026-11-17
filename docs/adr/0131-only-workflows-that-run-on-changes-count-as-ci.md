# Only workflows that run on changes count as CI

At each push Ted decides whether a repo has CI (ADR 0048, spec §9.9 rule 3). One signal was any `.yml` or `.yaml` file under `.github/workflows`. A repo whose workflows run only by hand, such as a release build, then counted as having CI: no check ever reported on the Task’s pull request, so the merge waited until the CI-stuck question.

The signal now reads each workflow’s `on:` and counts the file only when it names `pull_request`, `pull_request_target`, `push` or `merge_group`. A file Ted can’t parse, or one with no `on:`, still counts, so a mistake holds a merge and never skips CI. Branch filters under a trigger are not read. The other two signals, required status checks and a check on one of the last 20 base commits, are unchanged.

This repo’s own `ci.yml` now runs only when started by hand, because typecheck and lint already run as the Factory’s Checks in Validate and GitHub Actions minutes ran out. Until 20 commits without checks have landed on `main`, the recent-checks signal still says the repo has CI.
