# Design

## Goal

Decide how to build the change before building it.

## Skip when

The change is small and the approach is obvious. Post a one-line note saying Design had nothing to decide, then run `ted outcome advance --skip`.

## Steps

1. Read the Task, its brief, the code the change touches and the repo’s own `AGENTS.md` or `CLAUDE.md`, if there is one.
2. Work out the approach: which files and interfaces change, what new pieces there are, and how each acceptance criterion will be checked. For interfaces and module boundaries, use `codebase-design` if the skill is available to your agent; otherwise work out those boundaries from the existing code. Prefer existing public boundaries for tests. If earlier Stages left no criteria, derive them from the request and mark unresolved scope choices for the design review.
3. Write the approach into the Task brief with `ted brief write`: what changes, the choices you made, the verification plan and the questions left open. Compare alternatives where they change the result or a material tradeoff. A disposable prototype can settle a specific uncertainty; use `prototype` if the skill is available to your agent, or build a small throwaway prototype yourself. Keep its purpose and what it showed in the brief.
4. For UI work, show the human what it will look like: screenshots, a short screen recording if the flow matters, a single-file HTML prototype they can click through, or a Figma link. Light-mode images alone are sufficient. Keep the prototype in one file, with its scripts, styles and images inline; it runs in a sandbox with no network.
5. Write the design review as a JSON file and pass it to `ted outcome advance --design <file>`. Every field is optional:

   ```json
   {
     "title": "Onboarding: two steps instead of four",
     "summary": "One or two sentences on what you propose and why.",
     "screenshots": [{ "path": "design/step-1.png", "caption": "Step 1 · Welcome" }],
     "video": { "path": "design/walkthrough.mp4", "caption": "Walkthrough · 0:42" },
     "prototype": "design/onboarding.html",
     "figma": { "url": "https://www.figma.com/design/…", "label": "Onboarding v2 · 3 frames" },
     "worthYourEye": ["Each choice the human should look at closely, one per line."]
   }
   ```

   Paths are relative to the current folder. Screenshots are PNG, JPEG, GIF, WebP or SVG (up to 12); the video is MP4, WebM or QuickTime; the prototype is an HTML file. Each file is under 25 MB. Leave the files out of your commits. Without a title, the review takes the brief’s Goal.

## Done when

The approach is in the brief and the design review is posted with `ted outcome advance --design <file>`. With the Design Gate on, the human then approves it or asks for changes. If they ask for changes, the Task stays in Design: change the approach, write the brief again and post a new design review.

## Ask the human when

Two approaches are both reasonable and the choice changes what the human gets. Lay out both in the design review’s summary and Worth your eye.
