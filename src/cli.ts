#!/usr/bin/env node
import { claude } from "./claude.ts";
import { daemon } from "./daemon.ts";
import { type AdapterName, ADAPTERS, type Harness } from "./harness.ts";
import { loadFlow } from "./load.ts";
import { pi } from "./pi.ts";
import { type RunEvent, type RunState, resume, run } from "./run.ts";
import { serve } from "./server.ts";

const USAGE = `use: orchy run <flow file> [--harness pi|claude] [--events]
     orchy resume <run id> <json value> [--harness pi|claude] [--events]
     orchy daemon [--port 4000]

A flow file is TypeScript or YAML.
--events writes one JSON event for each line, for a parent process to read.`;

const PORT = 4000;

/** Typed by the names, so an adapter that goes missing fails the compiler. */
const HARNESSES: Record<AdapterName, Harness> = { pi, claude };

function report(event: RunEvent): void {
  switch (event.type) {
    case "run_start":
      return console.error(`◆ ${event.runId}`);
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

const argv = process.argv.slice(2);
const events = take(argv, "--events");
const at = argv.indexOf("--harness");
const chosen = at === -1 ? "pi" : (argv[at + 1] ?? "");
if (at !== -1) argv.splice(at, 2);
const port = number(argv, "--port") ?? PORT;

function take(list: string[], flag: string): boolean {
  const found = list.indexOf(flag);
  if (found === -1) return false;
  list.splice(found, 1);
  return true;
}

function number(list: string[], flag: string): number | undefined {
  const found = list.indexOf(flag);
  if (found === -1) return undefined;
  const value = Number(list[found + 1]);
  list.splice(found, 2);
  return Number.isFinite(value) ? value : undefined;
}

/** A parent process reads the events, so nothing else may reach the output stream. */
function emit(event: RunEvent): void {
  if (events) console.log(JSON.stringify(event));
  else report(event);
}

function finish(state: RunState): never {
  if (!events) {
    console.log(JSON.stringify(state, null, 2));
    if (state.status === "waiting") {
      console.error(`\nanswer with: orchy resume ${state.runId} '<json value>'`);
    }
  }
  process.exit(state.status === "failed" ? 1 : 0);
}

const harness = HARNESSES[chosen as AdapterName];
if (!harness) {
  console.error(`unknown harness "${chosen}". Use one of: ${ADAPTERS.join(", ")}`);
  process.exit(2);
}

const [command, first, second] = argv;

try {
  if (command === "run" && first) {
    const options = { onEvent: emit, harness, harnesses: HARNESSES };
    finish(await run(await loadFlow(first), options));
  }

  if (command === "resume" && first && second) {
    const options = { onEvent: emit, harness, harnesses: HARNESSES };
    finish(await resume(first, JSON.parse(second), options));
  }

  if (command === "daemon") {
    const engine = daemon(process.cwd());
    await serve(engine, port);
    // The daemon runs an agent on this machine, so it listens on this machine only.
    console.error(`orchy runs at http://127.0.0.1:${port} and works in ${engine.root}`);
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => {
        engine.close();
        process.exit(0);
      });
    }
  } else {
    console.error(USAGE);
    process.exit(2);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
