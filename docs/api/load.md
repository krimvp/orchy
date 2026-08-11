# `src/load.ts` — reading a flow from a file

This module turns a file on disk into a `Flow` (the interface in
`src/flow.ts`). A flow file is either YAML — parsed by `parseFlow` from
`src/yaml.ts` — or a TypeScript/JavaScript module whose default export is the
flow; the file's extension decides which, and both paths yield the same shape.

The module offers two views of the same file, and the difference between them
is the point. `readFlow` gives the flow exactly as the file holds it, with
nothing added — the editor writes this form back to disk, so it must not carry
a resolved path or an expanded step. `loadFlow` gives the flow a run needs:
every relative path resolved against the flow's own file (so a flow runs the
same from any working directory), and every `kind: "flow"` step replaced by
the steps of the flow it names, recursively, with the inner flows found
relative to the file that named them.

## Exports

- `readFlow(file, from?)` — resolves `file` against `from` (default: the
  current working directory) and returns a `Promise<Flow>` holding the file's
  content verbatim. A `.yaml`/`.yml` file goes through `parseFlow`; anything
  else is imported as a module and its default export is the flow.

- `loadFlow(file, from?)` — same signature, but returns the runnable form:
  it calls `readFlow`, then `resolvePaths` with the file's own directory, then
  `expandFlows`, loading each inner flow through `loadFlow` again so nesting
  works to any depth. The ids of an inner flow's steps take the id of the step
  that named it as a prefix, so using the same inner flow twice never
  collides.

## Example

Load a flow for a run, wherever the process happens to be started from:

```ts
import { loadFlow } from "./load.ts";

const flow = await loadFlow("flows/review.yaml");
console.log(flow.name);
console.log(flow.steps.map((step) => step.id));
// Paths in the steps are absolute, and any step that named another
// flow has been replaced by that flow's steps.
```

In practice the split follows the callers: `src/server.ts` reads with
`readFlow` when serving a flow to the editor, and both it and `src/cli.ts`
load with `loadFlow` when a run starts. Both functions are re-exported from
`src/index.ts` as part of the package's public surface.
