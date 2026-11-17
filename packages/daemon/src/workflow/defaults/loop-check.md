# Loop check · Validate

Validate has sent this Task back to Work several times. Decide whether the rounds are converging (each round fixes what the last one found and the findings get fewer or smaller) or looping (the same findings come back, fixes undo earlier fixes, or new findings keep replacing old ones without the work getting closer to done).

Below are the blocking findings of each round, oldest first, and the commit the worktree was at when each round sent the Task back. Read the diffs between those commits with `git diff <older> <newer>` in the current folder. Don’t change any files.

Your reason is shown to the human in a decision question. Use one or two plain-language sentences, at most 250 characters, explaining whether earlier fixes held and what remains or repeats. Keep technical evidence in your investigation; the reason should explain progress, not list files, revisions or review history. If the evidence cannot support either verdict, say why and leave the verdict out so TED asks with an unknown assessment.

End your final message with that short reason and then one line that is exactly `Verdict: converging` or `Verdict: looping` when supported.
