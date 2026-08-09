import { readFileSync } from "node:fs";
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
  if (/\.ya?ml$/.test(path)) return parseFlow(readFileSync(path, "utf8"));
  return (await import(pathToFileURL(path).href)).default as Flow;
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
