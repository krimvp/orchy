import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RunEvent, RunState } from "./run.ts";

/**
 * ADR 0008: the state on disk is the run. This database is an index of it, and
 * a place for what a directory cannot hold: the event of a run, and the flows a
 * user registers. `index()` rebuilds every run row from disk, so losing this
 * file loses no run.
 */
const SCHEMA = `
create table if not exists flow (
  id integer primary key,
  path text not null unique,
  name text not null,
  harness text not null,
  addedAt text not null
);
create table if not exists run (
  runId text primary key,
  flowName text not null,
  path text,
  status text not null,
  startedAt text not null,
  endedAt text,
  waitingFor text,
  question text,
  cost real,
  tokens integer
);
create table if not exists event (
  id integer primary key,
  runId text not null,
  at text not null,
  type text not null,
  json text not null
);
create index if not exists event_of_run on event(runId, id);
`;

export interface FlowRow {
  id: number;
  path: string;
  name: string;
  harness: string;
  addedAt: string;
}

export interface RunRow {
  runId: string;
  flowName: string;
  path: string | null;
  status: string;
  startedAt: string;
  endedAt: string | null;
  waitingFor: string | null;
  question: string | null;
  cost: number | null;
  tokens: number | null;
}

export type StoredEvent = RunEvent & { at: string };

/**
 * How many runs the index holds. The list gives back this many rows, so a run
 * that falls behind is a run that no page shows, and its events go. 200 rows
 * fill a list that a person reads, and ADR 0009 keeps the state and the
 * trajectory of every run on disk.
 */
export const KEPT = 200;

export type Store = ReturnType<typeof open>;

export function open(file: string) {
  const db = new DatabaseSync(file);
  db.exec("pragma journal_mode = wal");
  db.exec(SCHEMA);

  const all = <T>(sql: string, ...values: unknown[]): T[] =>
    db.prepare(sql).all(...(values as never[])) as T[];
  const one = <T>(sql: string, ...values: unknown[]): T | undefined =>
    db.prepare(sql).get(...(values as never[])) as T | undefined;

  return {
    close: (): void => db.close(),

    flows: (): FlowRow[] => all<FlowRow>("select * from flow order by name"),

    flow: (id: number): FlowRow | undefined => one<FlowRow>("select * from flow where id = ?", id),

    flowAt: (path: string): FlowRow | undefined => one<FlowRow>("select * from flow where path = ?", path),

    addFlow(path: string, name: string, harness: string): FlowRow {
      db.prepare(
        `insert into flow (path, name, harness, addedAt) values (?, ?, ?, ?)
         on conflict(path) do update set name = excluded.name, harness = excluded.harness`,
      ).run(path, name, harness, new Date().toISOString());
      return one<FlowRow>("select * from flow where path = ?", path) as FlowRow;
    },

    removeFlow: (id: number): void => void db.prepare("delete from flow where id = ?").run(id),

    runs: (limit = KEPT): RunRow[] => all<RunRow>("select * from run order by startedAt desc limit ?", limit),

    run: (runId: string): RunRow | undefined => one<RunRow>("select * from run where runId = ?", runId),

    saveRun(row: RunRow): void {
      db.prepare(
        `insert into run (runId, flowName, path, status, startedAt, endedAt, waitingFor, question, cost, tokens)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(runId) do update set
           status = excluded.status, endedAt = excluded.endedAt, waitingFor = excluded.waitingFor,
           question = excluded.question, cost = excluded.cost, tokens = excluded.tokens`,
      ).run(
        row.runId,
        row.flowName,
        row.path,
        row.status,
        row.startedAt,
        row.endedAt,
        row.waitingFor,
        row.question,
        row.cost,
        row.tokens,
      );
    },

    addEvent(runId: string, event: RunEvent): StoredEvent {
      const stored = { ...event, at: new Date().toISOString() };
      db.prepare("insert into event (runId, at, type, json) values (?, ?, ?, ?)").run(
        runId,
        stored.at,
        event.type,
        JSON.stringify(stored),
      );
      return stored;
    },

    events: (runId: string): StoredEvent[] =>
      all<{ json: string }>("select json from event where runId = ? order by id", runId).map(
        (row) => JSON.parse(row.json) as StoredEvent,
      ),

    /**
     * Drops the events of every run that falls behind the list. ADR 0009: the
     * state on disk is the run, so this costs the events and no run. It names
     * the rows it drops, so an event that reaches the index before its row does
     * stays.
     */
    trim(): void {
      db.prepare(
        "delete from event where runId in (select runId from run order by startedAt desc limit -1 offset ?)",
      ).run(KEPT);
    },

    /** Reads every run on disk, so a lost index costs nothing but the events. */
    index(runs: string): number {
      let found = 0;
      for (const runId of directories(runs)) {
        const state = stateAt(join(runs, runId, "state.json"));
        if (!state) continue;
        const row = rowOf(state, this.run(runId)?.path ?? null, metricsAt(join(runs, runId, "trajectory.json")));
        // The daemon starts here and drives no run yet, so nothing is running.
        if (row.status === "running") row.status = "stopped";
        this.saveRun(row);
        found += 1;
      }
      return found;
    },
  };
}

/** The row that describes a run state. The flow name and the cost come from it. */
export function rowOf(state: RunState, path: string | null, spend?: { cost?: number; tokens?: number }): RunRow {
  const records = Object.values(state.steps);
  const times = [...records, ...(state.history ?? []).map((one) => one.record)].map((record) => record.endedAt).sort();
  return {
    runId: state.runId,
    flowName: state.flow.name,
    path,
    status: state.status,
    startedAt: records.map((record) => record.startedAt).sort()[0] ?? (times[0] as string) ?? new Date().toISOString(),
    // A run that waits has not ended, so it reports no length yet.
    endedAt: state.status === "done" || state.status === "failed" ? (times[times.length - 1] ?? null) : null,
    waitingFor: state.waitingFor ?? null,
    question: state.question ?? null,
    cost: spend?.cost ?? null,
    tokens: spend?.tokens ?? null,
  };
}

function directories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function stateAt(file: string): RunState | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as RunState;
  } catch {
    return undefined;
  }
}

/** The cost and the tokens of a run live in its trajectory, not in its state. */
export function metricsAt(file: string): { cost?: number; tokens?: number } | undefined {
  try {
    const metrics = (JSON.parse(readFileSync(file, "utf8")) as { final_metrics?: Record<string, number> })
      .final_metrics;
    if (!metrics) return undefined;
    return {
      cost: metrics.cost_usd,
      tokens: (metrics.prompt_tokens ?? 0) + (metrics.completion_tokens ?? 0),
    };
  } catch {
    return undefined;
  }
}
