# Loop check · Validate

Validate has sent this Task back to Work several times. Decide whether the rounds are converging (each round fixes what the last one found and the Findings get fewer or smaller) or looping (the same Findings come back, fixes undo earlier fixes, or new Findings keep replacing old ones without the work getting closer to done).

Below are the blocking Findings of each round, oldest first, and the commit the worktree was at when each round sent the Task back. Read the diffs between those commits with `git diff <older> <newer>` in the current folder. Don’t change any files.

End your final message with a short reason and then one line that is exactly `Verdict: converging` or `Verdict: looping`.
