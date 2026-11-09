# Design reviews carry their parts, and prototypes run from their own scheme

Status: accepted. Builds on ADR 0073.

## Context

Spec §6.11 and §10.5 ask for a design review card with screenshot tiles, a video tile, an HTML prototype the human can click through in a sandboxed frame with **Restart** and **Open full size ↗**, a Figma link row and a “Worth your eye” box. Until now the Design Gate request was the Task brief as text. ADR 0073 shows HTML attachments in an `<iframe sandbox="" srcdoc>`, which inherits the app’s CSP: no scripts and no inline styles, so a prototype can’t be clicked through. KRI-145 will reuse the card for the setup Task’s proposal.

## Decision

**How the agent posts it.** At Design, `ted outcome advance --design <file>` takes a JSON file with an optional `title`, `summary`, `screenshots` (path and caption), `video`, `prototype`, `figma` (URL and label) and `worthYourEye` (a list of points). The CLI uploads each file with `POST /tasks/:id/attachments`, then sends the outcome with the files named by hash. The daemon checks each file is one its Task’s Runs uploaded (the ADR 0073 rule), that screenshots are images, the video is MP4, WebM or QuickTime, the prototype is HTML, and the Figma link is an `https://` URL on `figma.com`. Only Design may send `design`, and `--skip` can’t.

**Store.** The Gate request (`kind: review`) keeps the brief as its body and gets the files as ordinary Comment attachments, so deleting and retention work as before. The roles, captions, summary, link and points go in `v1.CommentDesignAttached` (`{ commentId, design }` as JSON), committed with the Comment; the Comment carries `design`. A `title` replaces the brief’s Goal as the card title. With the Design Gate off, TED posts the review as a note with the same files and moves on.

**The prototype.** The main process serves `ted-prototype://file/<hash>/<name>` with `protocol.handle`, reading the bytes through `DaemonClient.readAttachment` (ADR 0009), and answers with `Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; form-action 'none'; base-uri 'none'`. The card loads it in `<iframe sandbox="allow-scripts">`. The frame has an opaque origin, so it can’t reach the app’s DOM or `window.ted`; its CSP blocks every fetch, image or script from the network; the sandbox blocks popups, forms and top navigation; and the window refuses any subframe navigation to another scheme (`will-frame-navigate`). The renderer’s CSP gains `frame-src ted-prototype:` and `media-src blob:` (the video plays from a `blob:` URL). **Restart** remounts the frame; **Open full size ↗** shows the same frame in a dialog that fills the window.

**Figma.** **Open ↗** asks the main process to open the link; it reads the Comment from the daemon and opens only a `figma.com` link from it, never a URL the renderer passes.

## Considered Options

- **Attachment roles on `ted comment --attach`.** The human answers the Gate request, not a note, so the parts must arrive with the outcome that posts it. Rejected.
- **`allow-scripts` on the `srcdoc` frame.** It inherits the app’s `script-src 'self'`, so inline scripts still don’t run. Rejected.
- **A `blob:` or `data:` URL.** Both inherit the creator’s CSP, as `srcdoc` does. Rejected.
- **Opening the prototype in the system browser.** It would need the file written outside TED’s store and would run with network access. Rejected; full size stays in the app.

## Consequences

- Prototypes must be single files: scripts, styles, images and fonts inline or as `data:` URLs.
- Other HTML attachments still use the `srcdoc` frame of ADR 0073, with no scripts.
- The prototype frame is another place the main process reads attachments for the renderer; it only reads, by hash and name, through the same signed daemon route.
