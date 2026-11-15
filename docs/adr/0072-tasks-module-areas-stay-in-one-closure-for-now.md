# The Tasks module’s areas stay in one closure until their shared state has its own module

Architecture passes 2 and 3 proposed moving areas of `createTasks` (`packages/daemon/src/tasks/tasks.ts`, 5388 lines at pass 3) into internal factories, as `createSubAgents` and `createPullRequests` did. Pass 3 measured what each area reads from the closure and what the rest of the closure calls back into it:

| Area | Lines | Closure names it reads | Its names used elsewhere |
| --- | --- | --- | --- |
| GitHub watch and merge cycle | ~1080 | 45 | 11 |
| Lead choice and repo changes | ~390 | 33 | 12 |
| Send back and loop check | ~400 | 18 | 10 |
| Stall recovery | ~150 | 20 | 4 |
| Checks at Validate | ~160 | 13 | 8 |
| Idle nudge | ~80 | 12 | 4 |

Most of those names are per-Task sets and maps (`advancing`, `interrupted`, `holds`, `merging`, `stoppingForBlockers`) and the helpers that order side effects (`find`, `holding`, `deliver`, `move`, `pump`). A factory per area would take a deps object nearly as large as its body, so it would be a shallow module, and every new feature would edit both the factory and its deps.

## Decision

Don’t split `createTasks` by area. Keep ADR 0016: the Tasks module orders side effects.

The first step, when someone takes this on, is to put the per-Task in-flight state (the sets and maps above, and `holding`/`untilFree`) behind one module with a small interface. Areas can then move out with only that module, the store and a few callbacks as deps.

## Consequences

- Parallel tickets will keep conflicting in `tasks.ts`; resolve them by area.
- Code with no closure dependencies (the text helpers at the end of the file) can move out at any time; it is about 250 lines, so it was not worth a pass on its own.

## First step done (TED-350)

`packages/daemon/src/tasks/in-flight.ts` now holds the per-Task in-flight state: the one-transition lock (`advancing` and `released`, now `transition`, `transitionWhenFree` and `untilFree`), counted holds, and the `starting`, `checking`, `deleting`, `hierarchy`, `stoppingForBlockers` and `merging` marks. `tasks.ts` asks it with `is`, `busy` and `inHierarchyWork`, and passes the side effects of a release (queue activity, pending talks, the pump) as callbacks. Each busy check kept its exact kinds. Other per-Task sets (`stoppingByHand`, `beginning`, `relaunching`, `settingUp`) are still in the closure and can join it when an area that reads them moves out.
