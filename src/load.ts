import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type Flow, expandFlows, resolvePaths, validate } from "./flow.ts";
import { parseFlow } from "./yaml.ts";

/**
 * The flow that a file holds, with nothing added. The editor writes this back,
 * so it must not carry a resolved path or an expanded step.
 */
export async function readFlow(file: string, from = process.cwd()): Promise<Flow> {
  const path = resolve(from, file);
  if (!existsSync(path)) {
    throw new Error(`there is no flow file at "${path}". Name a file that is there, as a path from this directory.`);
  }
  if (/\.ya?ml$/.test(path)) return parseFlow(readFileSync(path, "utf8"), path);
  const flow = (await import(pathToFileURL(path).href)).default as Flow | undefined;
  if (!flow || typeof flow !== "object") {
    throw new Error(`the file "${path}" exports no flow. Write the flow as the default export.`);
  }
  // A file that builds a flow with `flow()` fills this in. A file that writes
  // the object itself does not, and the runner then reads a step with no needs
  // and says so in the words of Node. See ADR 0004: both make the same data.
  for (const step of flow.steps ?? []) if (!Array.isArray(step.needs)) step.needs = [];
  return flow;
}

/**
 * The flow that a run needs: every path resolved against its own file, and
 * every flow step replaced by the steps of the flow it names.
 *
 * Each file is checked before it is expanded, because expansion is what takes
 * a flow step away: after it, no step of the kind `flow` is left for
 * `validate()` to read, so every field on one — `when`, `tools`, `model`,
 * `changes` — went through in silence. `chain` holds the files above this one,
 * so a flow that names itself is refused instead of loading for ever.
 */
export async function loadFlow(file: string, from = process.cwd(), chain: string[] = []): Promise<Flow> {
  const path = resolve(from, file);
  const directory = dirname(path);
  const flow = await readFlow(path);
  const seen = [...chain, path];
  const resolved = resolvePaths(flow, directory);
  refuse(resolved, path);
  return expandFlows(resolved, (inner) => {
    const at = resolve(directory, inner);
    if (seen.includes(at)) {
      throw new Error(
        `the flow at "${at}" is open already: ${[...seen, at].join(" → ")}. A flow cannot hold itself, and a chain of flows cannot come back to one it holds.`,
      );
    }
    return loadFlow(inner, directory, seen);
  });
}

/** What a file's own flow gets wrong, named with the file, before it is expanded. */
function refuse(flow: Flow, path: string): void {
  const problems = validate(flow);
  if (problems.length > 0) {
    throw new Error(`the flow at "${path}" is not valid:\n- ${problems.join("\n- ")}`);
  }
}
