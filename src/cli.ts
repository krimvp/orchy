#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { claude } from "./claude.ts";
import { type AdapterName, ADAPTERS, type Harness } from "./harness.ts";
import { loadFlow } from "./load.ts";
import { pi } from "./pi.ts";
import { type RunEvent, type RunState, list, resume, run } from "./run.ts";

const VERSION = String(createRequire(import.meta.url)("../package.json").version);

const USAGE = `use: orchy run <flow file> [--with <json>] [--harness pi|claude] [--events]
     orchy resume <run id> [json value] [--from <step>] [--harness pi|claude] [--events]
     orchy runs [--events]
     orchy daemon [--port 4000]
     orchy --help | --version

A flow file is TypeScript or YAML.
--with supplies the values that the flow takes, as one JSON object.
--from continues a run that ended, from the step it names. With no value and
no step, a failed run goes back to the step that failed, and a stopped run
continues where it stood.
--events writes one JSON event for each line, for a parent process to read.

orchy runs lists the runs of this directory, newest first.

The command writes the events to the error stream and the run state to the
output stream. It ends with 0 when a run finishes, 1 when a run fails, 2 when
the command itself is wrong, and 3 when a run waits for a person.

A model comes from the harness, not from Orchy. Pi reads
~/.pi/agent/models.json and its own login; Claude Code reads its own account.
See the Install part of README.md.`;

const PORT = 4000;

/** What the shell learns. A wrong command and a failed run are not one thing. */
const EXIT = { done: 0, failed: 1, usage: 2, waiting: 3 } as const;

/** Typed by the names, so an adapter that goes missing fails the compiler. */
const HARNESSES: Record<AdapterName, Harness> = { pi, claude };

function report(event: RunEvent): void {
  switch (event.type) {
    case "run_start":
      return console.error(`◆ ${event.runId}`);
    case "step_start":
      return console.error(`▶ ${event.step}`);
    // The whole note, and not the first line of it. A tool answers in lines,
    // and the first of them says the least. A prompt lives in a file, so the
    // one the step really sent goes here, where a reader sees it.
    case "output":
      if (event.kind === "prompt") return console.error(`✎ ${event.step} asks:\n${indent(event.step, event.text)}`);
      return console.error(indent(event.step, event.text));
    case "step_end":
      if (event.status === "done") return console.error(`✓ ${event.step}`);
      return console.error(`✗ ${event.step}${event.error ? `\n  ${lines(event.error)}` : ""}`);
    // ADR 0014: a reader is never left to work out why a step never started.
    case "skip":
      return console.error(`⊘ ${event.step} does not run\n  ${lines(event.why)}`);
    case "cycle":
      return console.error(`↻ ${event.step} goes back to ${event.to} (${event.count})`);
    case "waiting":
      return console.error(`⏸ ${event.step} waits for a person\n  ${lines(event.question)}`);
    case "run_end":
      return console.error(`— ${event.status}${event.error ? `\n  ${lines(event.error)}` : ""}`);
  }
}

/** Every line of a note keeps the step that said it. */
function indent(step: string, text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${step} │ ${line}`)
    .join("\n");
}

/** A reason of many lines stays under the step it belongs to. */
function lines(text: string): string {
  return text.split("\n").join("\n  ");
}

/** A fault of the command, and not of a run. It ends with 2. */
class Wrong extends Error {}

/** What a wrong command says, and how it ends. Nothing here starts a run. */
function wrong(message: string): never {
  console.error(message);
  process.exit(EXIT.usage);
}

const argv = process.argv.slice(2);
const events = take(argv, "--events");
const at = argv.indexOf("--harness");
const chosen = at === -1 ? "pi" : (argv[at + 1] ?? "");
if (at !== -1) argv.splice(at, 2);

let given: string | undefined;
let from: string | undefined;
let port: number | undefined;
try {
  given = text(argv, "--with");
  from = text(argv, "--from");
  port = number(argv, "--port");
} catch (error) {
  wrong(error instanceof Error ? error.message : String(error));
}

function take(list: string[], flag: string): boolean {
  const found = list.indexOf(flag);
  if (found === -1) return false;
  list.splice(found, 1);
  return true;
}

function text(list: string[], flag: string): string | undefined {
  const found = list.indexOf(flag);
  if (found === -1) return undefined;
  const value = list[found + 1];
  list.splice(found, 2);
  return value;
}

/** The values that the flow takes. One JSON object, so every key has a name. */
function valuesOf(source: string | undefined): Record<string, unknown> | undefined {
  if (source === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Wrong(`--with holds "${source}", which is not JSON`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Wrong(`--with holds "${source}". Write one JSON object, such as '{"issue":123}'.`);
  }
  return value as Record<string, unknown>;
}

/**
 * A number the command line holds, or nothing. `--port abc` used to fall back
 * to the default in silence, and the daemon then listened where nobody looked.
 */
function number(list: string[], flag: string): number | undefined {
  const found = list.indexOf(flag);
  if (found === -1) return undefined;
  const source = list[found + 1];
  list.splice(found, 2);
  const value = Number(source);
  if (source === undefined || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Wrong(`${flag} holds "${source ?? ""}". Write a whole number from 1 to 65535.`);
  }
  return value;
}

/** A parent process reads the events, so nothing else may reach the output stream. */
function emit(event: RunEvent): void {
  // The run names itself here, so a signal knows the state file to mark.
  if (event.type === "run_start") running = { runId: event.runId, cwd: process.cwd() };
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
  if (state.status === "failed") process.exit(EXIT.failed);
  process.exit(state.status === "waiting" ? EXIT.waiting : EXIT.done);
}

/** The run this process drives, so a signal writes its state before it goes. */
let running: { runId: string; cwd: string } | undefined;

const [command, first, second] = argv;

if (command === "--help" || command === "-h" || command === "help" || command === undefined) {
  // Help is what the reader asked for, so it goes to the output stream and ends
  // with 0. A wrong command is a fault, and it takes the error stream and 2.
  console.log(USAGE);
  process.exit(command === undefined ? EXIT.usage : EXIT.done);
}

if (command === "--version" || command === "-v") {
  console.log(VERSION);
  process.exit(EXIT.done);
}

const harness = HARNESSES[chosen as AdapterName];
if (!harness) wrong(`unknown harness "${chosen}". Use one of: ${ADAPTERS.join(", ")}`);

try {
  if (command === "run") {
    if (!first) throw new Wrong(`orchy run wants a flow file.\n\n${USAGE}`);
    const options = { onEvent: emit, harness, harnesses: HARNESSES, with: valuesOf(given) };
    const flow = await loadFlow(first);
    watchForSignals();
    finish(await run(flow, options));
  }

  if (command === "resume") {
    if (!first) throw new Wrong(`orchy resume wants a run id.\n\n${USAGE}`);
    const options = { onEvent: emit, harness, harnesses: HARNESSES, from };
    let value: unknown;
    if (second !== undefined) {
      try {
        value = JSON.parse(second);
      } catch {
        throw new Wrong(`the answer holds ${second}, which is not JSON. Write the value as JSON.`);
      }
    }
    watchForSignals(first);
    finish(await resume(first, value, options));
  }

  if (command === "runs") {
    const runs = list(process.cwd());
    if (events) for (const state of runs) console.log(JSON.stringify(rowOf(state)));
    else console.log(runs.length === 0 ? "no run in this directory yet" : table(runs));
    process.exit(EXIT.done);
  }

  if (command === "daemon") {
    // The daemon keeps its index with `node:sqlite`, and Node calls that
    // experimental and says so. A run needs no index, so it loads only here.
    const { daemon } = await import("./daemon.ts");
    const { serve } = await import("./server.ts");
    const engine = daemon(process.cwd());
    await serve(engine, port ?? PORT);
    // The daemon runs an agent on this machine, so it listens on this machine only.
    console.error(`orchy runs at http://127.0.0.1:${port ?? PORT} and works in ${engine.root}`);
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => {
        engine.close();
        process.exit(EXIT.done);
      });
    }
  } else {
    console.error(`orchy has no command "${command}".\n\n${USAGE}`);
    process.exit(EXIT.usage);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Wrong) wrong(message);
  console.error(message);
  process.exit(EXIT.failed);
}

/** One row of `orchy runs`. */
function rowOf(state: RunState) {
  return {
    runId: state.runId,
    flowName: state.flow.name,
    status: state.status,
    startedAt: Object.values(state.steps).map((record) => record.startedAt).sort()[0] ?? "",
    ...(state.waitingFor ? { waitingFor: state.waitingFor } : {}),
  };
}

function table(runs: RunState[]): string {
  const rows = runs.map(rowOf);
  const wide = Math.max(...rows.map((row) => row.flowName.length));
  return rows
    .map((row) => `${row.runId}  ${row.status.padEnd(7)}  ${row.flowName.padEnd(wide)}  ${row.startedAt}`)
    .join("\n");
}

/**
 * ADR 0005: a crash and a gate recover the same way. A run that dies with its
 * state at `running` recovers no way at all, because `resume` refuses a run
 * that says it runs. So the process writes `stopped` before it goes.
 */
function watchForSignals(runId?: string): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      const at = running ?? (runId ? { runId, cwd: process.cwd() } : undefined);
      if (at) stopRun(at.cwd, at.runId);
      process.exit(EXIT.failed);
    });
  }
}

function stopRun(cwd: string, runId: string): void {
  try {
    const file = join(cwd, ".orchy", "runs", runId, "state.json");
    const state = JSON.parse(readFileSync(file, "utf8")) as RunState;
    if (state.status !== "running") return;
    state.status = "stopped";
    writeFileSync(file, JSON.stringify(state, null, 2));
  } catch {
    // A run with no state on disk yet has nothing to mark.
  }
}
