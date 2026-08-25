import type { Called } from "../run.ts";
import { lines } from "../memory.ts";

/**
 * Records what the run learned, in the store the flow declares. Bookkeeping is
 * a step and not a choice: a flow that ends with this one always records, where
 * an agent told to remember sometimes does. ADR 0028.
 *
 * `with: { text: "..." }` records that text. With no text it records the value
 * of each step it needs, one entry each, so a summarizing step before it is the
 * whole of what a flow has to write. `with: { tags: [...] }` marks every entry
 * it writes, and `recall_memory` reads a tag back.
 *
 * A flow that declares no memory fails here, because a step that says it
 * records and records nowhere is worse than a flow that will not start.
 */
export default (
  inputs: Record<string, unknown>,
  say: (text: string) => void,
  values: Record<string, unknown>,
  cwd?: string,
  run?: Called,
): { recorded: string[] } => {
  if (!run?.memory) {
    throw new Error(
      'the flow declares no memory, so there is nowhere to record. Give the flow a scope, as memory: { scope: "flow" }.',
    );
  }
  const tags = Array.isArray(values.tags) ? values.tags.map((one) => String(one)) : undefined;
  const store = lines(cwd ?? process.cwd());

  const written = (text: string) => {
    const entry = store.remember(run.memory?.key as string, {
      run: run.runId,
      step: run.step,
      text,
      ...(tags ? { tags } : {}),
    });
    say(`recorded ${entry.id}`);
    return entry.id;
  };

  if (typeof values.text === "string" && values.text.trim()) return { recorded: [written(values.text.trim())] };

  // No text of its own: the value of each step it needs is what it records, as
  // the text of that value. A step that needs nothing records nothing, and the
  // contract of the step says so.
  const recorded = Object.entries(inputs)
    .filter(([, value]) => value !== undefined)
    .map(([step, value]) => written(typeof value === "string" ? value : `${step}: ${JSON.stringify(value)}`));

  return { recorded };
};
