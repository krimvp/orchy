import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type RunEvent, read } from "./run.ts";
import { type Store, type StoredEvent, metricsAt, open, rowOf } from "./store.ts";

/**
 * How many runs the daemon starts at the same time. A run is a process that
 * drives a model, so a machine holds few of them. This is a constant, not a
 * setting: a user who wants more starts a second daemon.
 */
const RUNS = 4;

const CLI = resolve(import.meta.dirname, "cli.ts");

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
}

interface Job extends Ticket {
  harness: string;
  with?: Record<string, unknown>;
  runId?: string;
  /** A resume carries the value that answers the gate. */
  value?: unknown;
  child?: ChildProcess;
  stderr: string;
}

export type Daemon = ReturnType<typeof daemon>;

export function daemon(root: string) {
  const directory = join(resolve(root), ".orchy");
  const runs = join(directory, "runs");
  mkdirSync(runs, { recursive: true });

  const store: Store = open(join(directory, "index.db"));
  store.index(runs);

  const jobs = new Map<number, Job>();
  const notes = new Map<string, StoredEvent[]>();
  const queue: Job[] = [];
  const listeners = new Set<(notice: Notice) => void>();
  let running = 0;
  let tickets = 0;
  // A child ends after the daemon closes, so every handler stops here first.
  let closed = false;

  const tell = (notice: Notice) => {
    if (closed) return;
    for (const listener of listeners) listener(notice);
  };
  const told = () => tell({ kind: "queue", pending: [...jobs.values()].map(ticketOf) });

  const finish = (job: Job) => {
    // A run that reached a run id lives in the index from here on.
    if (job.runId) jobs.delete(job.ticket);
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
    if (ended && row.status === "running") row.status = "stopped";
    store.saveRun(row);
  };

  const receive = (job: Job, event: RunEvent) => {
    if (closed) return;
    if (event.type === "run_start") {
      job.runId = event.runId;
      told();
    }
    if (!job.runId) return;

    // The output of a step is a view, so it stays in memory and out of the index.
    if (event.type === "output") {
      const held = notes.get(job.runId) ?? [];
      const note = { ...event, at: new Date().toISOString() };
      held.push(note);
      if (held.length > NOTES) held.splice(0, held.length - NOTES);
      notes.set(job.runId, held);
      // Memory holds the last few runs. The trajectory of an older run holds more.
      for (const old of [...notes.keys()].slice(0, notes.size - RUNS_HELD)) notes.delete(old);
      tell({ kind: "event", runId: job.runId, event: note });
      return;
    }

    const stored = store.addEvent(job.runId, event);
    if (event.type !== "step_start") record(job);
    tell({ kind: "event", runId: job.runId, event: stored });
  };

  const pump = () => {
    while (running < RUNS && queue.length > 0) {
      const job = queue.shift() as Job;
      running += 1;
      // A resume reads the values from the state on disk, so only a run carries them.
      const args =
        job.value === undefined
          ? ["run", job.path, ...(job.with ? ["--with", JSON.stringify(job.with)] : [])]
          : ["resume", job.runId as string, JSON.stringify(job.value)];
      const child = spawn(process.execPath, [CLI, ...args, "--harness", job.harness, "--events"], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
      });
      job.child = child;
      lines(child, (line) => receive(job, JSON.parse(line) as RunEvent));
      child.stderr?.on("data", (chunk: Buffer) => {
        job.stderr = `${job.stderr}${chunk.toString()}`.slice(-4000);
      });
      child.on("error", (error) => {
        job.error = error.message;
        finish(job);
      });
      child.on("close", (code) => {
        record(job, true);
        // A run ends, so a run falls behind the list. The index bounds what it holds here.
        if (!closed) store.trim();
        // Never hide a failure: a child that started no run keeps its ticket and its reason.
        if (!job.runId) job.error = job.stderr.trim() || `the run ended with the code ${code}`;
        finish(job);
      });
    }
  };

  return {
    store,
    root,

    /** Puts a run in the queue. It starts when a slot is free. */
    start(order: Order): Ticket {
      tickets += 1;
      const job: Job = { ...order, ticket: tickets, queuedAt: new Date().toISOString(), stderr: "" };
      jobs.set(job.ticket, job);
      queue.push(job);
      pump();
      told();
      return ticketOf(job);
    },

    /** Answers the gate of a run that waits. The child checks the value again. */
    resume(runId: string, value: unknown, harness: string): Ticket {
      const row = store.run(runId);
      if (!row) throw new Error(`this daemon holds no run ${runId}`);
      if (row.status !== "waiting") throw new Error(`the run ${runId} is ${row.status}, so it takes no value`);
      tickets += 1;
      const job: Job = {
        ticket: tickets,
        flowName: row.flowName,
        path: row.path ?? "",
        harness,
        runId,
        value,
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
    stop(runId: string): boolean {
      const job = [...jobs.values()].find((one) => one.runId === runId);
      if (!job?.child) return false;
      job.child.kill("SIGTERM");
      return true;
    },

    /** What the steps of a run said while they worked, as far back as memory holds. */
    notes: (runId: string): StoredEvent[] => notes.get(runId) ?? [],

    pending: (): Ticket[] => [...jobs.values()].map(ticketOf),

    forget(ticket: number): void {
      jobs.delete(ticket);
      told();
    },

    state: (runId: string) => stateOf(root, runId),

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

    close(): void {
      closed = true;
      for (const job of jobs.values()) job.child?.kill("SIGTERM");
      listeners.clear();
      store.close();
    },
  };
}

function ticketOf(job: Job): Ticket {
  const ticket: Ticket = { ticket: job.ticket, flowName: job.flowName, path: job.path, queuedAt: job.queuedAt };
  if (job.runId) ticket.runId = job.runId;
  if (job.error) ticket.error = job.error;
  return ticket;
}

function stateOf(root: string, runId: string) {
  try {
    return read(root, runId);
  } catch {
    return undefined;
  }
}

/** The child writes one JSON event for each line, so a partial line waits here. */
function lines(child: ChildProcess, take: (line: string) => void): void {
  let rest = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    const parts = `${rest}${chunk.toString()}`.split("\n");
    rest = parts.pop() ?? "";
    for (const line of parts) if (line.trim()) take(line);
  });
}
