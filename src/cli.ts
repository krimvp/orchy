#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { claude } from "./claude.ts";
import { type Flow, expandFlows, resolvePaths } from "./flow.ts";
import type { Harness } from "./harness.ts";
import { pi } from "./pi.ts";
import { type RunEvent, type RunState, resume, run } from "./run.ts";
import { parseFlow } from "./yaml.ts";

const USAGE = `use: orchy run <flow file> [--harness pi|claude]
     orchy resume <run id> <json value> [--harness pi|claude]

A flow file is TypeScript or YAML.`;

const HARNESSES: Record<string, Harness> = { pi, claude };

async function load(file: string, from = process.cwd()): Promise<Flow> {
  const path = resolve(from, file);
  const flow = /\.ya?ml$/.test(path)
    ? parseFlow(readFileSync(path, "utf8"))
    : ((await import(pathToFileURL(path).href)).default as Flow);
  // A path inside a flow is relative to that flow, however deep it sits.
  return expandFlows(resolvePaths(flow, dirname(path)), (inner) => load(inner, dirname(path)));
}

function report(event: RunEvent): void {
  switch (event.type) {
    case "step_start":
      return console.error(`▶ ${event.step}`);
    case "step_end":
      return console.error(`${event.status === "done" ? "✓" : "✗"} ${event.step}`);
    case "cycle":
      return console.error(`↻ ${event.step} goes back to ${event.to} (${event.count})`);
    case "waiting":
      return console.error(`⏸ ${event.step} waits for a person\n  ${event.question}`);
    case "run_end":
      return console.error(`— ${event.status}`);
  }
}

function finish(state: RunState): never {
  console.log(JSON.stringify(state, null, 2));
  if (state.status === "waiting") {
    console.error(`\nanswer with: orchy resume ${state.runId} '<json value>'`);
  }
  process.exit(state.status === "failed" ? 1 : 0);
}

const argv = process.argv.slice(2);
const at = argv.indexOf("--harness");
const chosen = at === -1 ? "pi" : (argv[at + 1] ?? "");
if (at !== -1) argv.splice(at, 2);

const harness = HARNESSES[chosen];
if (!harness) {
  console.error(`unknown harness "${chosen}". Use one of: ${Object.keys(HARNESSES).join(", ")}`);
  process.exit(2);
}

const [command, first, second] = argv;

try {
  if (command === "run" && first) {
    finish(await run(await load(first), { onEvent: report, harness, harnesses: HARNESSES }));
  }

  if (command === "resume" && first && second) {
    finish(await resume(first, JSON.parse(second), { onEvent: report, harness, harnesses: HARNESSES }));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

console.error(USAGE);
process.exit(2);
