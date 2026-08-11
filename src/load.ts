import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type Flow, expandFlows, resolvePaths } from "./flow.ts";
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
 */
export async function loadFlow(file: string, from = process.cwd()): Promise<Flow> {
  const path = resolve(from, file);
  const directory = dirname(path);
  const flow = await readFlow(path);
  return expandFlows(resolvePaths(flow, directory), (inner) => loadFlow(inner, directory));
}
