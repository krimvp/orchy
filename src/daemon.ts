import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { schemaProblem } from "./flow.ts";
import { RUN_GROUP, terminate } from "./process.ts";
import { type RunEvent, keep, read, standing } from "./run.ts";
import { type Store, type StoredEvent, due, metricsAt, open, rowOf } from "./store.ts";
import { claimed, processIdentity } from "./claim.ts";

/**
 * How many runs the daemon starts at the same time. A run is a process that
 * drives a model, so a machine holds few of them. This is a constant, not a
 * setting: a user who wants more starts a second daemon.
 */
const RUNS = 4;

// Orchy runs from source as TypeScript and from a published copy as JavaScript,
// so a file it starts or loads takes the extension it is running under itself.
const EXT = import.meta.filename.endsWith(".ts") ? ".ts" : ".js";
const CLI = resolve(import.meta.dirname, `cli${EXT}`);

/**
 * How many notes a run keeps while it works. The output of a step is a view,
 * and the trajectory is the record, so the daemon holds the last of it in
 * memory and writes none of it to the index.
 */
const NOTES = 500;

/** How many runs keep their notes. An older run has its trajectory instead. */
const RUNS_HELD = 20;

/** A run that the daemon accepted. It holds a ticket until a child gives it a run id. */
export interface Ticket {
  ticket: number;
  flowName: string;
  path: string;
  queuedAt: string;
  runId?: string;
  /** The child ended before it started a run. The text says why. */
  error?: string;
}

export type Notice =
  | { kind: "event"; runId: string; event: StoredEvent }
  | { kind: "queue"; pending: Ticket[] };

export interface Order {
  path: string;
  flowName: string;
  harness: string;
  /** The values the flow takes. The daemon passes them on, and the child checks them. */
  with?: Record<string, unknown>;
  /** The run and the step that placed this order, when a step did. ADR 0025. */
  startedBy?: { runId: string; step: string };
  /** The durable child slot held before this order entered a process-local queue. */
  reservation?: string;
  plannedRunId?: string;
}

interface Job extends Ticket {
  harness: string;
  with?: Record<string, unknown>;
  startedBy?: { runId: string; step: string };
  runId?: string;
  /** The job continues a run instead of starting one. */
  resumes?: boolean;
  /** The value that answers the gate, when the run waits for one. */
  value?: unknown;
  /** The step the run goes back to, when a person names one. */
  from?: string;
  /** The gate and state revision this answer was written for. */
  gate?: string;
  revision?: number;
  reservation?: string;
  plannedRunId?: string;
  /**
   * The run reached its end, or a gate, and the child is on its way out. The
   * job lives on until the process closes, and a person who answers a gate the
   * moment it appears must not hear that the run "is already on its way".
   */
  settled?: boolean;
  /** The child has closed. The job may still hold a ticket, for its reason. */
  done?: boolean;
  child?: ChildProcess;
  /** The one stop of this owned process tree. */
  stopping?: Promise<void>;
  stderr: string;
}

export type Daemon = ReturnType<typeof daemon>;

/**
 * `beats` says whether this daemon fires the schedules. The long daemon does.
 * A second one over the same root — the MCP door, see ADR 0024 — must not,
 * because two beats would fire one schedule twice.
 */
export function daemon(root: string, beats = true) {
  const directory = join(resolve(root), ".orchy");
  const runs = join(directory, "runs");
  mkdirSync(runs, { recursive: true });

  const store: Store = open(join(directory, "index.db"));
  store.index(runs);

  const jobs = new Map<number, Job>();
  const notes = new Map<string, StoredEvent[]>();
  const queue: Job[] = [];
  const stops = new Map<string, Promise<boolean>>();
  const failedStops = new Map<string, Job>();
  const listeners = new Set<(notice: Notice) => void>();
  let running = 0;
  let tickets = 0;
  // The order of receipt. Two events in one millisecond still line up by it.
  let order = 0;
  // A child ends after the daemon closes, so every handler stops here first.
  let closed = false;
  let closing: Promise<void> | undefined;

  const tell = (notice: Notice) => {
    if (closed) return;
    for (const listener of listeners) listener(notice);
  };
  const told = () => tell({ kind: "queue", pending: [...jobs.values()].map(ticketOf) });
  const release = (job: Job) => {
    if (!job.reservation) return;
    store.releaseStart(job.reservation);
    job.reservation = undefined;
  };

  const finish = (job: Job) => {
    if (job.done) return;
    job.done = true;
    // A run that reached a run id lives in the index from here on. A job that
    // ended with a reason of its own keeps its ticket, so the reason reaches a
    // person: a resume that a contract refused leaves no other trace.
    if (job.runId && !job.error) jobs.delete(job.ticket);
    running -= 1;
    if (closed) return;
    pump();
    told();
  };

  const record = (job: Job, ended = false) => {
    if (closed || !job.runId) return;
    const state = stateOf(root, job.runId);
    if (!state) return;
    const row = rowOf(state, job.path, metricsAt(join(runs, job.runId, "trajectory.json")));
    // The child has gone, so a run that still says running is stopped.
    if (ended && row.status === "running" && !stops.has(job.runId) && !failedStops.has(job.runId)) {
      row.status = "stopped";
    }
    store.saveRun(row);
  };

  /** Writes the terminal state after no owned process can change the workspace. */
  const markStopped = (job: Job) => {
    if (!job.runId) return;
    const state = stateOf(root, job.runId);
    if (!state || (state.status !== "running" && state.status !== "waiting")) return;
    state.status = "stopped";
    state.pid = undefined;
    delete state.waitingFor;
    delete state.question;
    keep(join(runs, job.runId), state);
    store.saveRun(rowOf(state, job.path, metricsAt(join(runs, job.runId, "trajectory.json"))));
    const event = store.addEvent(job.runId, { type: "run_end", status: "stopped" });
    tell({ kind: "event", runId: job.runId, event });
  };

  const receive = (job: Job, event: RunEvent) => {
    if (closed) return;
    if (!job.runId && event.type !== "run_start") {
      throw new Error(`the run control channel sent "${event.type}" before it named the run`);
    }
    if (event.type === "run_start" && job.runId && event.runId !== job.runId) {
      throw new Error(`the run control channel named ${event.runId}, but this job drives ${job.runId}`);
    }
    if (job.settled) throw new Error(`the run control channel sent "${event.type}" after the run settled`);
    if (event.type === "run_start") {
      job.runId = event.runId;
      told();
    }
    // The run stops here. The child takes a moment more to go, and in that
    // moment the index already says `waiting`, so a page that answers at once
    // used to be refused.
    if (event.type === "waiting" || event.type === "run_end") job.settled = true;
    if (!job.runId) return;

    // The output of a step is a view, so it stays in memory and out of the index.
    if (event.type === "output") {
      const held = notes.get(job.runId) ?? [];
      const note = { ...event, at: new Date().toISOString(), seq: (order += 1) };
      held.push(note);
      if (held.length > NOTES) held.splice(0, held.length - NOTES);
      notes.set(job.runId, held);
      // Memory holds the last few runs. The trajectory of an older run holds more.
      for (const old of [...notes.keys()].slice(0, notes.size - RUNS_HELD)) notes.delete(old);
      tell({ kind: "event", runId: job.runId, event: note });
      return;
    }

    const stored = store.addEvent(job.runId, event, (order += 1));
    if (event.type !== "step_start") record(job);
    // The indexed child now counts in `starts.most`, so its reservation can go.
    if (event.type === "run_start") release(job);
    tell({ kind: "event", runId: job.runId, event: stored });
  };

  /** A run has one child. A job that continues a run waits for the one before it. */
  const held = (job: Job) =>
    job.runId !== undefined &&
    [...jobs.values()].some((one) => one !== job && one.runId === job.runId && !one.done);

  const pump = () => {
    while (running < RUNS && queue.length > 0) {
      const at = queue.findIndex((one) => !held(one));
      if (at === -1) return;
      const [job] = queue.splice(at, 1) as [Job];
      running += 1;
      // A resume reads the values from the state on disk, so only a run carries them.
      const args = job.resumes
        ? [
            "resume",
            job.runId as string,
            ...(job.value === undefined ? [] : [JSON.stringify(job.value)]),
            ...(job.from ? ["--from", job.from] : []),
            ...(job.gate ? ["--gate", job.gate] : []),
            ...(job.revision === undefined ? [] : ["--revision", String(job.revision)]),
          ]
        : [
            "run",
            job.path,
            ...(job.with ? ["--with", JSON.stringify(job.with)] : []),
            ...(job.startedBy ? ["--started-by", JSON.stringify(job.startedBy)] : []),
            ...(job.plannedRunId ? ["--run-id", job.plannedRunId] : []),
          ];
      const child = spawn(process.execPath, [CLI, ...args, "--harness", job.harness, "--event-fd", "3"], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        env: { ...process.env, [RUN_GROUP]: "1" },
      });
      job.child = child;
      if (job.reservation && job.plannedRunId && child.pid) {
        store.attachStart(job.reservation, job.plannedRunId, child.pid, processIdentity(child.pid));
      }
      // Component stdout is ordinary output. It never shares the control channel.
      child.stdout?.resume();
      lines(
        child.stdio[3] as NodeJS.ReadableStream,
        (line) => receive(job, eventOf(line)),
        (error) => {
          job.error = error.message;
        },
      );
      child.stderr?.on("data", (chunk: Buffer) => {
        job.stderr = `${job.stderr}${chunk.toString()}`.slice(-4000);
      });
      child.on("error", (error) => {
        job.error = error.message;
        release(job);
        finish(job);
      });
      child.on("close", (code) => {
        if (!job.runId) release(job);
        record(job, true);
        // A run ends, so a run falls behind the list. The index bounds what it holds here.
        if (!closed) store.trim();
        // Never hide a failure: a child that ended badly keeps its ticket and its
        // reason. A resume that a contract refused ends this way, and dropping
        // it left a person pressing a button that answered nothing.
        // A child that reported an end of its own already said why, through its
        // events. A child that ended badly and said nothing keeps its reason
        // here: a resume that a contract refused leaves no other trace, and a
        // person who pressed a button heard nothing at all.
        if (code !== 0 && !job.settled) {
          job.error = job.stderr.trim() || `the run ended with the code ${code}`;
        }
        finish(job);
      });
    }
  };

  /** Puts a run in the queue. It starts when a slot is free. */
  const start = (order: Order): Ticket => {
    tickets += 1;
    const job: Job = {
      ...order,
      ticket: tickets,
      queuedAt: new Date().toISOString(),
      stderr: "",
      ...(order.reservation ? { plannedRunId: order.plannedRunId ?? randomUUID() } : {}),
    };
    jobs.set(job.ticket, job);
    queue.push(job);
    pump();
    told();
    return ticketOf(job);
  };

  /**
   * Fires every schedule that is due, through the same door a person uses. A
   * flow whose last scheduled run still works is skipped — runs must not stack
   * behind a slow one — and it fires when that run has gone.
   */
  const fire = () => {
    if (closed) return;
    for (const held of store.schedules()) {
      const row = store.flow(held.flowId);
      if (!row) {
        store.clearSchedule(held.flowId);
        continue;
      }
      if (!due(held, new Date())) continue;
      if ([...jobs.values()].some((job) => job.path === row.path)) continue;
      store.markScheduled(held.flowId, new Date().toISOString());
      start({
        path: row.path,
        flowName: row.name,
        harness: row.harness,
        with: held.withJson ? (JSON.parse(held.withJson) as Record<string, unknown>) : undefined,
      });
    }
  };
  const beat = beats ? setInterval(fire, 30_000) : undefined;

  return {
    store,
    root,

    /**
     * Reads the runs on disk that the index does not hold, or that it thinks
     * are still going. A run started at the command line belongs to no job of
     * this daemon, so nothing else would ever tell the index about it.
     */
    catchUp(): void {
      if (!closed) store.index(runs, false, new Set([...stops.keys(), ...failedStops.keys()]));
    },

    start,

    /**
     * Continues a run. A value answers a gate. No value continues a run that
     * ended, from the step `from` names or where the run stood. The child
     * checks the details again; this refuses only what a row already refutes.
     */
    resume(runId: string, value: unknown, harness: string, from?: string, step?: string, revision?: number): Ticket {
      if (stops.has(runId)) throw new Error(`the run ${runId} is stopping, so it cannot continue`);
      const row = store.run(runId);
      if (!row) throw new Error(`this daemon holds no run ${runId}`);
      if (row.status === "running") throw new Error(`the run ${runId} is running, so there is nothing to continue`);
      if (value !== undefined && row.status !== "waiting") {
        throw new Error(`the run ${runId} is ${row.status}, so it takes no value`);
      }
      if (value === undefined && !from && row.status === "waiting") {
        throw new Error(`the run ${runId} waits for a value. Answer it, or name a step to go back to.`);
      }
      if (value === undefined && !from && row.status === "done") {
        throw new Error(`the run ${runId} is done. Name the step to run again.`);
      }
      // The contract of the gate is checked here, at the door, and not later in
      // a child. A queued answer that the contract refuses answered 200 with a
      // ticket, redrew the same form, and left its reason on another page under
      // the words "did not start". The command line refused it at once, and now
      // both surfaces say the same thing at the same moment.
      const current = stateOf(root, runId);
      if (value !== undefined) {
        if (revision === undefined) {
          throw new Error(`the answer for run ${runId} holds no revision. Read the run and send its current revision.`);
        }
        const problem = answerProblem(root, runId, value, step);
        if (problem) throw new Error(problem);
        if (revision !== undefined && revision !== (current?.revision ?? 0)) {
          throw new Error(
            `the run ${runId} moved from revision ${revision} to ${current?.revision ?? 0}. Read the run and answer the question it asks now.`,
          );
        }
        const expected = revision ?? current?.revision ?? 0;
        if ([...jobs.values()].some((job) => job.runId === runId && job.revision === expected && !job.done)) {
          throw new Error(`the run ${runId} already has an answer for revision ${expected}`);
        }
      }
      // The state on disk can say waiting before the pipe delivers the word,
      // and an answer given in that moment used to be refused here. The state
      // is the run (ADR 0005), so only a run it says is running is on its
      // way; the queue holds a resume until the child before it has gone.
      if (
        [...jobs.values()].some((job) => job.runId === runId && !job.settled && !job.done) &&
        stateOf(root, runId)?.status === "running"
      ) {
        throw new Error(`the run ${runId} is already on its way`);
      }
      tickets += 1;
      const job: Job = {
        ticket: tickets,
        flowName: row.flowName,
        path: row.path ?? "",
        harness,
        runId,
        resumes: true,
        value,
        from,
        gate: value === undefined ? undefined : (step ?? current?.waitingFor),
        revision: value === undefined ? undefined : (revision ?? current?.revision ?? 0),
        queuedAt: new Date().toISOString(),
        stderr: "",
      };
      jobs.set(job.ticket, job);
      queue.push(job);
      pump();
      told();
      return ticketOf(job);
    },

    /** Ends a run that is on the way. The state on disk keeps what it reached. */
    async stop(runId: string): Promise<boolean> {
      const existing = stops.get(runId);
      if (existing) return existing;
      const failed = failedStops.get(runId);
      const related = [
        ...[...jobs.values()].filter((job) => job.runId === runId && !job.done),
        ...(failed ? [failed] : []),
      ];
      if (related.length === 0) return false;

      const stopping = (async () => {
        // A queued continuation must not start when the active child closes.
        // It was accepted for a state that this stop now ends.
        for (let at = queue.length - 1; at >= 0; at -= 1) {
          const job = queue[at] as Job;
          if (job.runId !== runId) continue;
          queue.splice(at, 1);
          job.done = true;
          jobs.delete(job.ticket);
          if (job.reservation) store.releaseStart(job.reservation);
        }

        const active = related.filter((job) => job.child && (!job.done || job === failed));
        for (const job of active) {
          // A stop is an end a person asked for, so it is not a failed start.
          job.settled = true;
          job.stopping = terminate(job.child as ChildProcess, true);
        }
        try {
          await Promise.all(active.map((job) => job.stopping as Promise<void>));
        } catch (error) {
          failedStops.set(runId, (active[0] ?? related[0]) as Job);
          throw error;
        }
        failedStops.delete(runId);
        markStopped((active[0] ?? related[0]) as Job);
        told();
        return true;
      })();
      stops.set(runId, stopping);
      try {
        return await stopping;
      } finally {
        stops.delete(runId);
      }
    },

    /**
     * Ends a run that no child drives: one that waits at a gate, or one that a
     * dead daemon left behind. The state on disk is the run, so the truth goes
     * there, and the row and the listeners hear the same status.
     */
    async abandon(runId: string): Promise<boolean> {
      if (stops.has(runId) || failedStops.has(runId)) return false;
      return claimed(join(runs, runId), runId, async () => {
        if (stops.has(runId) || failedStops.has(runId)) return false;
        const state = stateOf(root, runId);
        if (!state || (state.status !== "waiting" && state.status !== "running")) return false;
        state.status = "stopped";
        delete state.waitingFor;
        delete state.question;
        keep(join(runs, runId), state);
        const path = store.run(runId)?.path ?? null;
        store.saveRun(rowOf(state, path, metricsAt(join(runs, runId, "trajectory.json"))));
        tell({ kind: "event", runId, event: store.addEvent(runId, { type: "run_end", status: "stopped" }) });
        return true;
      });
    },

    /** What the steps of a run said while they worked, as far back as memory holds. */
    notes: (runId: string): StoredEvent[] => notes.get(runId) ?? [],

    pending: (): Ticket[] => [...jobs.values()].map(ticketOf),

    forget(ticket: number): void {
      jobs.delete(ticket);
      told();
    },

    // A run whose process has gone is not running, whatever its file still says.
    state: (runId: string) => {
      const state = stateOf(root, runId);
      return state && (stops.has(runId) || failedStops.has(runId) ? state : standing(state));
    },

    trajectory(runId: string): unknown {
      try {
        return JSON.parse(readFileSync(join(runs, runId, "trajectory.json"), "utf8"));
      } catch {
        return undefined;
      }
    },

    watch(listener: (notice: Notice) => void): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    /** Checks the schedules now, so a test does not wait for the clock. */
    fire,

    /**
     * `kill` says what happens to the children. The long daemon takes its
     * runs down with it. The MCP door leaves them to finish: a run is its own
     * process and its state is on disk, so a dispatcher's runs outlive the
     * step that started them. ADR 0025.
     */
    close(kill = true): Promise<void> {
      if (closing) return closing;
      closed = true;
      clearInterval(beat);
      if (!kill) {
        for (const job of jobs.values()) {
          if (!job.child || job.done) release(job);
          else job.reservation = undefined;
        }
      }
      listeners.clear();
      closing = (async () => {
        if (kill) {
          const active = [...jobs.values()].filter((job) => job.child && !job.done);
          await Promise.all(
            active.map(async (job) => {
              job.settled = true;
              job.stopping ??= terminate(job.child as ChildProcess, true);
              await job.stopping;
              markStopped(job);
            }),
          );
        }
        if (kill) for (const job of jobs.values()) release(job);
        store.close();
      })();
      return closing;
    },
  };
}

function ticketOf(job: Job): Ticket {
  const ticket: Ticket = { ticket: job.ticket, flowName: job.flowName, path: job.path, queuedAt: job.queuedAt };
  if (job.runId) ticket.runId = job.runId;
  if (job.error) ticket.error = job.error;
  return ticket;
}

/**
 * Why the gate of a waiting run refuses this answer, or nothing when it takes
 * it. The state on disk is the run, so the contract comes from there — the same
 * schema the child would check the value against, read at the same moment the
 * person presses the button.
 */
function answerProblem(root: string, runId: string, value: unknown, answering?: string): string | undefined {
  const state = stateOf(root, runId);
  if (!state?.waitingFor) return undefined;
  // An answer that names the gate it was written for is not given to another
  // one. Two people on a two-gate run crossed answers this way: one answered
  // the first question, and the other's answer to that same question was
  // recorded against the second, and the run finished.
  if (answering !== undefined && answering !== state.waitingFor) {
    return `the run ${runId} waits at "${state.waitingFor}", and this answer is for "${answering}". Read the question it asks now.`;
  }
  const step = state.flow.steps.find((one) => one.id === state.waitingFor);
  if (!step || step.kind === "flow") return undefined;
  const problem = schemaProblem(step.returns, value);
  return problem && `the value of "${step.id}" breaks the contract ${problem}`;
}

function stateOf(root: string, runId: string) {
  try {
    return read(root, runId);
  } catch {
    return undefined;
  }
}

/** The child writes one JSON event for each line, so a partial line waits here. */
function lines(stream: NodeJS.ReadableStream, take: (line: string) => void, fault: (error: Error) => void): void {
  let rest = "";
  stream.on("data", (chunk: Buffer) => {
    const parts = `${rest}${chunk.toString()}`.split("\n");
    rest = parts.pop() ?? "";
    for (const line of parts) {
      if (!line.trim()) continue;
      try {
        take(line);
      } catch (error) {
        fault(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });
  stream.on("end", () => {
    if (rest.trim()) fault(new Error("the run control channel ended with an incomplete event"));
  });
}

/** A control line must hold one complete event, with the fields its type needs. */
function eventOf(line: string): RunEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("the run control channel wrote malformed JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("the run control channel wrote a value that is not an event");
  }
  const event = value as Record<string, unknown>;
  const text = (name: string) => typeof event[name] === "string";
  const number = (name: string) => typeof event[name] === "number" && Number.isFinite(event[name]);
  const optionalText = (name: string) => event[name] === undefined || text(name);
  const valid =
    (event.type === "run_start" && text("runId")) ||
    (event.type === "step_start" && text("step")) ||
    (event.type === "output" &&
      text("step") &&
      ["prompt", "text", "reasoning", "tool", "result"].includes(String(event.kind)) &&
      text("text")) ||
    (event.type === "step_end" &&
      text("step") &&
      ["done", "failed"].includes(String(event.status)) &&
      optionalText("error")) ||
    (event.type === "skip" && text("step") && text("why")) ||
    (event.type === "cycle" && text("step") && text("to") && number("count") && number("limit")) ||
    (event.type === "accept" && text("step") && text("to") && number("limit")) ||
    (event.type === "waiting" && text("step") && text("question")) ||
    (event.type === "run_end" &&
      ["running", "waiting", "done", "failed", "stopped"].includes(String(event.status)) &&
      optionalText("error"));
  if (!valid) throw new Error(`the run control channel wrote an invalid "${String(event.type)}" event`);
  return value as RunEvent;
}
