# TED

TED (“Totally Excellent Development”) is a desktop app for running software factories: agents carry development tasks through a configurable workflow, and the human steers through an inbox and comments. Vocabulary lives in `GLOSSARY.md`; use its terms.

## Issue tracker: Linear

- Workspace `kriyadesign`, team **Kriya Design** (`KRI`), project **TED**: https://linear.app/kriyadesign/project/ted-4c57b190ffe4/overview
- Create every issue in that team and project. Check for an existing issue before creating one.
- Comments and discussion go on the issue as Linear comments.

### Wayfinding operations

Used by `/wayfinder`.

- **Map**: an issue in the TED project labelled `wayfinder:map`.
- **Ticket**: a sub-issue of the map (`parentId` = the map), labelled with exactly one of `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, `wayfinder:task`. Map and tickets carry no other labels.
- **Blocking**: Linear’s native “blocked by” relation.
- **Frontier**: open sub-issues of the map with no assignee whose blockers are all completed or canceled; lowest identifier first.
- **Claim**: assign the ticket to the dev driving the map before any work.
- **Resolve**: post the answer as a comment, move the ticket to Done, then add a line (linked title + one-line gist) to the map’s Decisions so far.
- **Out of scope**: move the ticket to Canceled and add a line to the map’s Out of scope section.

## Code review before merge

Every code change gets a review before it merges to `main`, usually from Codex (`/codex-review`). Fix or answer each confirmed finding before merging.

## Designs: Figma

- File: https://www.figma.com/design/SLTyztzQXHFdz4sk3TcePk/TED?node-id=0-1 (file key `SLTyztzQXHFdz4sk3TcePk`)
- Put designs and prototypes on that page or on sibling pages in the same file. Link the frame from the Linear issue it answers.

## Domain docs

- `GLOSSARY.md` at the repo root. Architecture decisions go in `docs/adr/`.
- The v1 spec is `docs/spec/ted-v1-spec.md`. Next to it are `ted-v1-gaps.md`, which holds the open questions, and `ted-v1-screens.md`, which maps each screen to its Figma frames.
