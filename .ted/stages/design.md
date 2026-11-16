# Design

## Goal

Decide how to build the change before building it. Only a visual change goes to the user as a design review for approval.

A change is visual when it changes what a screen looks like or how the user moves through it: new or changed screens, layouts, components, dialogs or flows. A change that only rewords labels or messages is not visual.

## Skip when

The change is small and the approach is obvious, visual or not. Post a one-line note saying Design had nothing to decide, then run `ted outcome advance --skip`.

## When the change is not visual

Work out the approach the same way, but don’t ask the user to approve it:

1. Follow steps 1 to 3 below: read, work out the approach, and write it into the Task brief.
2. Post a short note with `ted comment` that leads with the approach and the choices that matter, so the user can follow it without opening the brief.
3. Clarify should already have settled any choice that changes what the user gets. If two reasonable approaches would still give the user different results, ask a plain question with `ted comment --choice "<approach>" --choice "<approach>" "<question>"`, end your turn, and record the answer in the brief.
4. Run `ted outcome advance --skip`. It moves the Task on without the Design sign-off.

Never post a design review, or run `ted outcome advance` without `--skip`, for a change that is not visual: both ask the user to sign off. After this file, Ted adds a line saying Design has a sign-off and to run `ted outcome advance` when the work is done. That line is for a visual change; for a change that is not visual, this section applies.

## Steps

For a visual change, follow every step. For a change that is not visual, follow steps 1 to 3, then the section above.

1. Read the Task, its brief, the code the change touches and the repo’s own `AGENTS.md` or `CLAUDE.md`, if there is one.
2. Work out the approach: which files and interfaces change, what new pieces there are, and how each acceptance criterion will be checked. For interfaces and module boundaries, use `codebase-design` if the skill is available to your agent; otherwise work out those boundaries from the existing code. Prefer existing public boundaries for tests. If earlier Stages left no criteria, derive them from the request and mark unresolved scope choices for the design review.
3. Write the approach into the Task brief with `ted brief write`: what changes, the choices you made, the verification plan and the questions left open. Compare alternatives where they change the result or a material tradeoff. A disposable prototype can settle a specific uncertainty; use `prototype` if the skill is available to your agent, or build a small throwaway prototype yourself. Keep its purpose and what it showed in the brief.
4. For UI work, choose the material that shows the design clearly. A single-file HTML prototype the human can click through is sufficient on its own; omit screenshots of that same prototype. Use images for a Figma layout or other design reference, including alongside a prototype when they show something different. A short screen recording can help when the flow matters. Light-mode images alone are sufficient. Keep the prototype in one file, with its scripts, styles and images inline; it runs in a sandbox with no network.
5. Write the design review as a JSON file and pass it to `ted outcome advance --design <file>`. Every field is optional. For a prototype review:

   ```json
   {
     "title": "Onboarding: two steps instead of four",
     "summary": "One or two sentences on what you propose and why.",
     "prototype": "design/onboarding.html",
     "worthYourEye": ["Each choice the human should look at closely, one per line."]
   }
   ```

   For other review material, use these optional fields as needed:

   - `screenshots`: `[{ "path": "design/step-1.png", "caption": "Step 1 · Welcome" }]`
   - `video`: `{ "path": "design/walkthrough.mp4", "caption": "Walkthrough · 0:42" }`
   - `figma`: `{ "url": "https://www.figma.com/design/…", "label": "Onboarding v2 · 3 frames" }`

   Paths are relative to the current folder. Screenshots are PNG, JPEG, GIF, WebP or SVG (up to 12); the video is MP4, WebM or QuickTime; the prototype is an HTML file. Each file is under 25 MB. Leave the files out of your commits. Without a title, the review takes the brief’s Goal.

## Done when

For a visual change: the approach is in the brief and the design review is posted with `ted outcome advance --design <file>`. With the Design sign-off on, the human then approves it or asks for changes. If they ask for changes, the Task stays in Design: change the approach, write the brief again and post a new design review.

## Ask the human when

Two approaches to a visual change are both reasonable and the choice changes what the human gets. Lay out both in the design review’s summary and Worth your eye.
