#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type Flow, resolvePaths } from "./flow.ts";
import { type RunEvent, type RunState, resume, run } from "./run.ts";
import { parseFlow } from "./yaml.ts";

const USAGE = `use: orchy run <flow file>
     orchy resume <run id> <json value>

A flow file is TypeScript or YAML.`;

async function load(file: string): Promise<Flow> {
  const path = resolve(file);
  const flow = /\.ya?ml$/.test(path)
    ? parseFlow(readFileSync(path, "utf8"))
    : ((await import(pathToFileURL(path).href)).default as Flow);
  return resolvePaths(flow, dirname(path));
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

const [command, first, second] = process.argv.slice(2);

try {
  if (command === "run" && first) {
    finish(await run(await load(first), { onEvent: report }));
  }

  if (command === "resume" && first && second) {
    finish(await resume(first, JSON.parse(second), { onEvent: report }));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

console.error(USAGE);
process.exit(2);
