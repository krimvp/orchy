#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { claude } from "./claude.ts";
import { droid } from "./droid.ts";
import { type AdapterName, ADAPTERS, type Harness } from "./harness.ts";
import { type Flow, validate } from "./flow.ts";
import { loadFlow } from "./load.ts";
import { pi } from "./pi.ts";
import { type RunEvent, type RunState, Refused, keep, list, resume, run, startOf } from "./run.ts";

const VERSION = String(createRequire(import.meta.url)("../package.json").version);

const USAGE = `use: orchy run <flow file> [--with <json>] [--harness pi|claude|droid] [--events]
     orchy check <flow file> [--harness pi|claude|droid]
     orchy resume <run id> [json value] [--from <step>] [--harness pi|claude|droid] [--events]
     orchy runs [--events]
     orchy daemon [--port 4000]
     orchy mcp [--harness pi|claude|droid]
     orchy --help | --version

A flow file is TypeScript or YAML.
--with supplies the values that the flow takes, as one JSON object.
--from continues a run that ended, from the step it names. With no value and
no step, a failed run goes back to the step that failed, and a stopped run
continues where it stood.
--events writes one JSON event for each line, for a parent process to read.
--started-by records the run and the step that started this one, as one JSON
object. The door of a run passes it; a person has no use for it.

orchy check reads a flow, and every flow it holds, and says what is wrong with
it. It runs nothing and spends nothing.

orchy runs lists the runs of this directory, newest first.

orchy mcp serves the Model Context Protocol on stdin and stdout, so an agent
writes flows and runs them here. It fires no schedule; the daemon does.

The command writes the events to the error stream and the run state to the
output stream. It ends with 0 when a run finishes, 1 when a run fails, 2 when
the command, its values, or the flow it was given is wrong and nothing ran,
and 3 when a run waits for a person.

A model comes from the harness, not from Orchy. Pi reads
~/.pi/agent/models.json and its own login; Claude Code reads its own account;
Droid reads ~/.factory/config.json. See the Install part of README.md.`;

const PORT = 4000;

/** What the shell learns. A wrong command and a failed run are not one thing. */
const EXIT = { done: 0, failed: 1, usage: 2, waiting: 3 } as const;

/** Typed by the names, so an adapter that goes missing fails the compiler. */
const HARNESSES: Record<AdapterName, Harness> = { pi, claude, droid };

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
      return console.error(`↻ ${event.step} goes back to ${event.to} (${event.count} of ${event.limit})`);
    // The run goes on, and the step it went on from still says no. A reader
    // who saw only "✓" and "— done" took that for agreement.
    case "accept":
      return console.error(
        `≠ ${event.step} still disagrees after ${event.limit} cycle${event.limit === 1 ? "" : "s"} back to ${event.to}, and the flow accepts that`,
      );
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

/**
 * The flags each command takes. A flag on the wrong command passed in silence:
 * `orchy run flow.yaml --from fix` ran the whole flow from the top, and the
 * person who wrote it read the wrong run for a while.
 */
const FLAGS: Record<string, string[]> = {
  run: ["--with", "--harness", "--events", "--started-by"],
  resume: ["--from", "--harness", "--events"],
  check: ["--harness"],
  runs: ["--events"],
  daemon: ["--port"],
  mcp: ["--harness"],
};

/** The flags that take a value. The rest stand alone. */
const VALUED = ["--with", "--from", "--harness", "--port", "--started-by"];

const argv: string[] = [];
const flags = new Map<string, string | true>();
for (let at = 0; at < process.argv.length - 2; at += 1) {
  const one = process.argv[at + 2] as string;
  if (!one.startsWith("--") || one === "--help" || one === "--version") {
    argv.push(one);
    continue;
  }
  // The first of two won in silence, and the second was the one just typed.
  if (flags.has(one)) wrong(`${one} is given twice. Give it once.`);
  if (!VALUED.includes(one)) {
    flags.set(one, true);
    continue;
  }
  const value = process.argv[at + 3];
  // `--with` at the end of the line ran the flow with no values at all.
  if (value === undefined || value.startsWith("--")) wrong(`${one} wants a value, and holds none.\n\n${USAGE}`);
  flags.set(one, value);
  at += 1;
}

const events = flags.has("--events");
const chosen = (flags.get("--harness") as string | undefined) ?? "pi";
const given = flags.get("--with") as string | undefined;
const from = flags.get("--from") as string | undefined;
const starter = flags.get("--started-by") as string | undefined;
let port: number | undefined;
try {
  port = number(flags.get("--port") as string | undefined);
} catch (error) {
  wrong(error instanceof Error ? error.message : String(error));
}

/**
 * The flow a file holds. A file that will not load is a fault of what the
 * command was given, not of a run: it ends with the code for a wrong command,
 * and not with the one that says a run failed.
 */
async function read(file: string) {
  try {
    return await loadFlow(file);
  } catch (error) {
    throw new Wrong(error instanceof Error ? error.message : String(error));
  }
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

/** The run and the step that started this run, when the door of a run says so. */
function starterOf(source: string | undefined): { runId: string; step: string } | undefined {
  if (source === undefined) return undefined;
  let value: { runId?: unknown; step?: unknown };
  try {
    value = JSON.parse(source) as typeof value;
  } catch {
    throw new Wrong(`--started-by holds "${source}", which is not JSON`);
  }
  if (typeof value.runId !== "string" || typeof value.step !== "string") {
    throw new Wrong(`--started-by wants one JSON object with "runId" and "step"`);
  }
  return { runId: value.runId, step: value.step };
}

/**
 * A number the command line holds, or nothing. `--port abc` used to fall back
 * to the default in silence, and the daemon then listened where nobody looked.
 */
function number(source: string | undefined): number | undefined {
  if (source === undefined) return undefined;
  const value = Number(source);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Wrong(`--port holds "${source}". Write a whole number from 1 to 65535.`);
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
      // The shape of the answer stands beside the command that gives it, so a
      // person writes it once. The step a gate stands in for holds the shape.
      const gate = state.flow.steps.find((step) => step.id === state.waitingFor);
      const shape = gate && gate.kind !== "flow" ? `\nthe value matches: ${JSON.stringify(gate.returns)}` : "";
      console.error(`\nanswer with: orchy resume ${state.runId} '<json value>'${shape}`);
    }
  }
  if (state.status === "failed") process.exit(EXIT.failed);
  process.exit(state.status === "waiting" ? EXIT.waiting : EXIT.done);
}

/** The run this process drives, so a signal writes its state before it goes. */
let running: { runId: string; cwd: string } | undefined;

const [command, first, second] = argv;

// `orchy run --help` asks for help as much as `orchy --help` does.
if (argv.some((one) => one === "--help" || one === "-h") || command === "help" || command === undefined) {
  // Help is what the reader asked for, so it goes to the output stream and ends
  // with 0. A wrong command is a fault, and it takes the error stream and 2.
  console.log(USAGE);
  process.exit(command === undefined ? EXIT.usage : EXIT.done);
}

if (command === "--version" || command === "-v") {
  console.log(VERSION);
  process.exit(EXIT.done);
}

// A flag orchy does not know, or an argument beyond what the command takes,
// used to pass in silence — and a typo like "--wiht" then ran a flow that
// failed later for a missing value, naming the wrong fault.
const known = Object.values(FLAGS).flat();
const strange = [...flags.keys()].filter((one) => !known.includes(one));
if (strange.length > 0) wrong(`orchy does not know ${strange.join(", ")}.\n\n${USAGE}`);
if (command in FLAGS) {
  const takes = FLAGS[command] as string[];
  const misplaced = [...flags.keys()].filter((one) => !takes.includes(one));
  if (misplaced.length > 0) wrong(`orchy ${command} does not take ${misplaced.join(", ")}.\n\n${USAGE}`);
}
const most: Record<string, number> = { run: 2, resume: 3, check: 2, runs: 1, daemon: 1, mcp: 1 };
if (command in most && argv.length > (most[command] as number)) {
  wrong(`orchy ${command} does not take "${argv[most[command] as number]}".\n\n${USAGE}`);
}

const harness = HARNESSES[chosen as AdapterName];
if (!harness) wrong(`unknown harness "${chosen}". Use one of: ${ADAPTERS.join(", ")}`);

try {
  if (command === "run") {
    if (!first) throw new Wrong(`orchy run wants a flow file.\n\n${USAGE}`);
    const options = {
      onEvent: emit,
      harness,
      harnessName: chosen,
      harnesses: HARNESSES,
      with: valuesOf(given),
      startedBy: starterOf(starter),
    };
    const flow = await read(first);
    watchForSignals();
    finish(await run(flow, options));
  }

  if (command === "resume") {
    if (!first) throw new Wrong(`orchy resume wants a run id.\n\n${USAGE}`);
    const options = { onEvent: emit, harness, harnessName: chosen, harnesses: HARNESSES, from };
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

  if (command === "check") {
    if (!first) throw new Wrong(`orchy check wants a flow file.\n\n${USAGE}`);
    // Loading is what checks: every file of a chain is read and validated, and
    // the harness of this command is the one a step that names none would use.
    const flow = await read(first);
    const problems = validate(flow, chosen);
    if (problems.length > 0) throw new Wrong(`the flow is not valid:\n- ${problems.join("\n- ")}`);
    // What the flow takes is the next thing the person types, so say it here.
    console.log(`${first} is valid: ${flow.steps.length} step${flow.steps.length === 1 ? "" : "s"}${takes(flow)}`);
    process.exit(EXIT.done);
  }

  if (command === "runs") {
    const runs = list(process.cwd());
    if (events) for (const state of runs) console.log(JSON.stringify(rowOf(state)));
    else console.log(runs.length === 0 ? "no run in this directory yet" : table(runs));
    process.exit(EXIT.done);
  }

  if (command === "mcp") {
    const { daemon } = await import("./daemon.ts");
    const { mcp } = await import("./mcp.ts");
    // ADR 0024: the long daemon fires the schedules, so this one does not, and
    // the two can stand over one root without firing one schedule twice.
    const engine = daemon(process.cwd(), false);
    // A step that holds the `orchy` tool reaches this door, and its adapter
    // says which run asked, so the runs it starts record it. ADR 0025.
    mcp(engine, chosen, process.stdin, process.stdout, starterOf(process.env.ORCHY_STARTED_BY));
    const leave = () => {
      // The runs this door started live on: each is its own process, and its
      // state is on disk. A dispatcher's runs must outlive the step's door.
      engine.close(false);
      process.exit(EXIT.done);
    };
    // The client owns the conversation: when it closes stdin, the door closes.
    process.stdin.on("end", leave);
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, leave);
  } else if (command === "daemon") {
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
  // A refusal at the door started no run and changed none, so it is a fault
  // of the command, not of a run. A script that heard "failed" went looking
  // for a failed run that did not exist.
  if (error instanceof Wrong || error instanceof Refused) wrong(message);
  console.error(message);
  process.exit(EXIT.failed);
}

/**
 * What a flow takes, for the line `orchy check` prints: each name and its
 * type, and which are required. A person who reads it writes `--with` once.
 */
function takes(flow: Flow): string {
  const schema = flow.takes as { properties?: Record<string, { type?: unknown }>; required?: string[] } | undefined;
  const names = Object.keys(schema?.properties ?? {});
  if (names.length === 0) return "";
  const required = new Set(schema?.required ?? []);
  const each = names.map((name) => {
    const type = schema?.properties?.[name]?.type;
    const kind = typeof type === "string" ? type : "value";
    return `${name} (${kind}${required.has(name) ? "" : ", optional"})`;
  });
  return `. It takes: ${each.join(", ")}. Supply them with --with '{"${names[0]}": …}'.`;
}

/** One row of `orchy runs`. A failed run says why, and a waiting run says for whom. */
function rowOf(state: RunState) {
  return {
    runId: state.runId,
    flowName: state.flow.name,
    status: state.status,
    startedAt: startOf(state),
    ...(state.waitingFor ? { waitingFor: state.waitingFor } : {}),
    ...(state.status === "failed" && state.error ? { error: state.error } : {}),
  };
}

function table(runs: RunState[]): string {
  const rows = runs.map(rowOf);
  const wide = Math.max("flow".length, ...rows.map((row) => row.flowName.length));
  const line = (id: string, status: string, flow: string, started: string, why: string) =>
    `${id.padEnd(36)}  ${status.padEnd(7)}  ${flow.padEnd(wide)}  ${started.padEnd(24)}  ${why}`.trimEnd();
  return [
    line("run", "status", "flow", "started", ""),
    ...rows.map((row) =>
      line(
        row.runId,
        row.status,
        row.flowName,
        row.startedAt,
        // The first line of the reason. The run holds the rest.
        row.error ? (row.error.split("\n")[0] as string) : row.waitingFor ? `waits for "${row.waitingFor}"` : "",
      ),
    ),
  ].join("\n");
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
    const directory = join(cwd, ".orchy", "runs", runId);
    const state = JSON.parse(readFileSync(join(directory, "state.json"), "utf8")) as RunState;
    if (state.status !== "running") return;
    state.status = "stopped";
    keep(directory, state);
  } catch {
    // A run with no state on disk yet has nothing to mark.
  }
}
