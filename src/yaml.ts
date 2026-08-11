import { parse, stringify } from "yaml";
import type { Flow, Step } from "./flow.ts";

/**
 * A file is a serialization of the flow data, not a friendlier language. Every
 * field maps one to one, and a contract is plain JSON Schema. So a graphical
 * editor writes the same file with no translation.
 */
export function parseFlow(text: string, file?: string): Flow {
  // A parser reports a line and a column, and the reader has many files open.
  const named = file ? ` in "${file}"` : "";
  let raw: (Omit<Partial<Flow>, "steps"> & { steps?: Array<Partial<Step>> }) | null;
  try {
    raw = parse(text) as typeof raw;
  } catch (error) {
    throw new Error(`the YAML${named} is not valid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!raw || typeof raw !== "object") throw new Error(`the file${named} holds no flow`);

  // Every field passes through. A parser that keeps only the fields it knows
  // drops the rest in silence, and `parallel` went that way for a while.
  // `validate()` is the one gate, and it refuses a field that no step reads.
  return {
    ...raw,
    name: String(raw.name ?? ""),
    steps: (raw.steps ?? []).map((step) => ({ needs: [], ...step }) as Step),
  };
}

/**
 * The inverse of `parseFlow`, so a graphical editor writes the file that it
 * read. It writes the data and nothing else, so it drops a comment and it
 * writes the fields in the order of the data.
 */
export function formatFlow(flow: Flow): string {
  const clean = JSON.parse(JSON.stringify(flow)) as Flow;
  for (const step of clean.steps ?? []) {
    // `parseFlow` adds this to every step, so writing it back is only noise.
    if (step.needs?.length === 0) delete (step as Partial<Step>).needs;
  }
  return stringify(clean, { lineWidth: 100 });
}
