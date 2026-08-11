# `src/tail.ts` — following a file as it grows

This module watches a file that another process is still writing, and hands
over each complete line as it appears. A harness writes its record one line
at a time while it works, so a step can report what it does by reading the
record the harness already writes — no adapter needs a second channel to say
the same thing.

The file may not exist when the watching starts, because a harness creates it
only after it begins. So the watcher takes a function that looks for the file,
and keeps asking until the function names one. Every 250 ms it reads whatever
the file has gained since the last read. A line that is only half written
waits until its rest arrives; a file that shrank is taken for a different
file and read again from the top; blank lines are skipped; a read that fails
(the file gone, or not yet there) is simply tried again on the next beat.

## Exports

- `tail(find, take)` — starts following a file and returns a function that
  stops. `find` is called until it returns a path (return `undefined` while
  the file does not exist yet); `take` receives each whole, non-blank line as
  a string, in order. The returned stop function performs one final read
  before clearing the timer, so lines written just before the end are never
  lost.

## Example

Follow a transcript that a session will create, and stop when the session
ends:

```ts
import { tail } from "./tail.ts";

const stop = tail(
  () => findTranscript(sessionId), // undefined until the file exists
  (line) => console.log(JSON.parse(line).type),
);

// ... the session runs, and each line prints as it lands ...

stop(); // reads whatever remains, then stops the timer
```

In practice the callers are the harness adapters: `src/claude.ts` tails the
Claude transcript and `src/pi.ts` tails the pi session file, each passing the
lines on to a watcher. The function is re-exported from `src/index.ts` as
part of the package's public surface.
