import { closeSync, openSync, readSync, statSync } from "node:fs";

/** How often a file that grows is read again. */
const BEAT = 250;

/**
 * Reads a file as it grows, and gives each whole line to `take`.
 *
 * A harness writes its record one line at a time while it works. So a step
 * reports what it does by reading the record that it already writes, and no
 * adapter needs a second way to say the same thing.
 *
 * `find` runs until it names a file, because a harness makes the file after it
 * starts. The return value stops the reading.
 */
export function tail(find: () => string | undefined, take: (line: string) => void): () => void {
  let path: string | undefined;
  let at = 0;
  let rest = "";

  const read = () => {
    path ??= find();
    if (!path) return;
    let text: string;
    try {
      const size = statSync(path).size;
      // A file that shrank is a different file, so start again from the top.
      if (size < at) at = 0;
      if (size === at) return;
      const file = openSync(path, "r");
      const buffer = Buffer.alloc(size - at);
      try {
        readSync(file, buffer, 0, buffer.length, at);
      } finally {
        closeSync(file);
      }
      at = size;
      text = buffer.toString("utf8");
    } catch {
      return;
    }

    // The last line of a read may be half written, so it waits for the rest.
    const lines = `${rest}${text}`.split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) take(line);
  };

  const timer = setInterval(read, BEAT);
  return () => {
    // One last read, so the end of the work is never lost.
    read();
    clearInterval(timer);
  };
}
