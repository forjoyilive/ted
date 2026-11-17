# Failure cases, Runs and tracker keys in a Task’s messages are links

Agents name Failure cases and Runs by their 6-character short reference (`0007fc`), and these looked like commit hashes but led nowhere (TED-525). A question card’s first line was drawn as plain text, so a Task ID there (`TED-523`) never linked either. The user chose links that say what they name and lead to it. This extends ADR 0128.

- **6-character codes.** `references` finds `short` references: exactly 6 lowercase hex characters, with the commit boundaries. `TaskReferences` matches a code against the start of the Task’s Failure case and Run IDs, both UUIDs. It links only when exactly one matches, so a code that matches nothing or several things stays plain.
- **Where they lead.** A Failure case scrolls the thread to its latest question card (`FailureDecision.commentId`), or else to the Check run line that recorded it (`failureTarget`), and highlights it briefly with `data-found`. A Finding that was never asked about has neither, so it stays plain. A Run opens its Conversation, like a Run tab.
- **The kind as plain text.** A linked commit, Failure case or Run has its kind before it as plain text (“failure a50acd”), not part of the link, unless the words just before already name it (`kindLabel`). The user found a linked “failure” odd to read. Task IDs and paths get no label.
- **Question card titles** go through `ReferenceText`.
- **Tracker keys.** A key that isn’t a Task the app holds opens the Task whose `source.linear.identifier` it is. If that is the open Task, it opens the Task’s issue URL instead. A key whose prefix is a Factory’s key stays plain. Any other key goes to the app-only `GET /integrations/linear/issue-links?ids=…`. With the stored Linear key, that route asks Linear about up to 50 identifiers in one query and returns the URL of each one Linear found. The link opens that URL in the browser and shows a ↗ mark.

## Considered Options

- **Make the whole “failure 0007fc” the link.** This was the first design. The user asked for the label as plain text.
- **Link tested contexts too.** The user chose Failure cases and Runs only.
- **Build the Linear URL from the key without asking Linear.** Words like `UTF-8` would become dead links.

## Consequences

- With no Linear key stored, or when Linear can’t be reached, a tracker key stays plain until the app reconnects.
- A 6-character run of digits, such as a date, is looked up like a short reference. It links only if it starts a Failure case or Run ID.
