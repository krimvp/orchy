# `src/yaml.ts` — the flow file as YAML

This module converts between the text of a flow file and a `Flow` (the
interface in `src/flow.ts`). The file is a serialization of the flow data,
not a friendlier language: every field maps one to one, and a contract is
plain JSON Schema. So a graphical editor writes the same file with no
translation, and reading a file and writing it back preserves the data
exactly.

Both directions pass every field through. A parser that keeps only the
fields it knows drops the rest in silence — `parallel` went that way for a
while — so this one keeps them all and leaves validation to `validate()`,
the one gate, which refuses a field that no step reads.

## Exports

- `parseFlow(text)` — parses YAML text and returns a `Flow`. `name` becomes
  a string (empty if absent), every step gains a `needs: []` when the file
  gives none, and everything else passes through untouched. Text that holds
  no object at all throws `"the file holds no flow"`.

- `formatFlow(flow)` — the inverse: returns the YAML text for a flow, so an
  editor writes the file that it read. It writes the data and nothing else —
  a comment is dropped, the fields come out in the order of the data, and an
  empty `needs` (the one thing `parseFlow` adds) is removed again, since
  writing it back is only noise. Lines wrap at 100 columns.

## Example

Read a flow file, change it, and write it back:

```ts
import { parseFlow, formatFlow } from "./yaml.ts";

const flow = parseFlow(readFileSync("flows/review.yaml", "utf8"));
flow.budget = 5;
writeFileSync("flows/review.yaml", formatFlow(flow));
// The file differs only in the budget — every other field survives
// the round trip, known to the parser or not.
```

In practice the callers are the two ends of the file's life: `src/load.ts`
parses with `parseFlow` when `readFlow` meets a `.yaml`/`.yml` file, and
`src/server.ts` writes with `formatFlow` when the editor saves a flow. Both
functions are re-exported from `src/index.ts` as part of the package's
public surface.
