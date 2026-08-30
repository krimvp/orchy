import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { alive, keep, type RunEvent, type RunState } from "./run.ts";

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
  tokens integer,
  withJson text,
  startedByJson text,
  error text
);
create table if not exists event (
  id integer primary key,
  runId text not null,
  at text not null,
  type text not null,
  json text not null
);
create index if not exists event_of_run on event(runId, id);
create table if not exists schedule (
  flowId integer primary key,
  everyMinutes integer not null,
  withJson text,
  lastAt text
);
create table if not exists hook (
  flowId integer primary key,
  token text not null unique,
  addedAt text not null
);
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
  /**
   * The values the run took, as JSON. Two runs of one flow differ by these and
   * by nothing else a list can show, so the list shows them.
   */
  withJson: string | null;
  /** The run and the step that started this run, as JSON, when a step did. */
  startedByJson: string | null;
  /**
   * Why the run failed, so a list says it without opening the run: the fault of
   * the run itself, or the failed step's error under its name.
   */
  error: string | null;
}

/**
 * `seq` holds the order of receipt: two events can land in the same
 * millisecond, and a clock alone cannot put them back in line.
 */
export type StoredEvent = RunEvent & { at: string; seq?: number };

/** A flow that runs by itself: how often, and with which values. */
export interface ScheduleRow {
  flowId: number;
  everyMinutes: number;
  withJson: string | null;
  lastAt: string | null;
}

/**
 * A schedule that has never fired is due now — that is what scheduling it
 * asked for. After that, it is due when its interval has passed.
 */
export function due(schedule: Pick<ScheduleRow, "everyMinutes" | "lastAt">, now: Date): boolean {
  if (!schedule.lastAt) return true;
  return now.getTime() - Date.parse(schedule.lastAt) >= schedule.everyMinutes * 60_000;
}

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

  // `create table if not exists` leaves a table that is already there alone, so
  // a column added later arrives here. `index()` fills it from the state on disk.
  const columns = db.prepare("pragma table_info(run)").all() as Array<{ name: string }>;
  for (const column of ["withJson", "startedByJson", "error"]) {
    if (!columns.some((held) => held.name === column)) {
      db.exec(`alter table run add column ${column} text`);
    }
  }

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

    removeFlow(id: number): void {
      db.prepare("delete from flow where id = ?").run(id);
      // A schedule or a hook without its flow would fire nothing, so both go with it.
      db.prepare("delete from schedule where flowId = ?").run(id);
      db.prepare("delete from hook where flowId = ?").run(id);
    },

    /** The token that starts this flow from a POST, when a person made one. */
    hook: (flowId: number): string | undefined =>
      one<{ token: string }>("select token from hook where flowId = ?", flowId)?.token,

    /** The flow a token starts, or nothing when no hook holds the token. */
    hooked: (token: string): number | undefined =>
      one<{ flowId: number }>("select flowId from hook where token = ?", token)?.flowId,

    setHook(flowId: number, token: string): void {
      db.prepare(
        "insert into hook (flowId, token, addedAt) values (?, ?, ?) on conflict(flowId) do update set token = excluded.token",
      ).run(flowId, token, new Date().toISOString());
    },

    clearHook: (flowId: number): void => void db.prepare("delete from hook where flowId = ?").run(flowId),

    schedules: (): ScheduleRow[] => all<ScheduleRow>("select * from schedule"),

    schedule: (flowId: number): ScheduleRow | undefined =>
      one<ScheduleRow>("select * from schedule where flowId = ?", flowId),

    /** Keeps `lastAt`: a change of pace is not a reason to fire right now. */
    setSchedule(flowId: number, everyMinutes: number, values?: Record<string, unknown>): void {
      db.prepare(
        `insert into schedule (flowId, everyMinutes, withJson) values (?, ?, ?)
         on conflict(flowId) do update set everyMinutes = excluded.everyMinutes, withJson = excluded.withJson`,
      ).run(flowId, everyMinutes, values ? JSON.stringify(values) : null);
    },

    clearSchedule: (flowId: number): void =>
      void db.prepare("delete from schedule where flowId = ?").run(flowId),

    markScheduled: (flowId: number, at: string): void =>
      void db.prepare("update schedule set lastAt = ? where flowId = ?").run(at, flowId),

    /** Every run, or every run of one flow file, newest first. */
    runs: (path?: string, limit = KEPT): RunRow[] =>
      path
        ? all<RunRow>("select * from run where path = ? order by startedAt desc limit ?", path, limit)
        : all<RunRow>("select * from run order by startedAt desc limit ?", limit),

    run: (runId: string): RunRow | undefined => one<RunRow>("select * from run where runId = ?", runId),

    /**
     * The runs the steps of one run started, every one. The list of runs
     * shows a page, and a bound counted from a page lifts in silence when
     * enough newer runs push the children off it. ADR 0027 counts from here.
     */
    children(runId: string): RunRow[] {
      return all<RunRow>("select * from run where startedByJson is not null order by startedAt desc").filter((row) => {
        try {
          return (JSON.parse(row.startedByJson as string) as { runId?: string }).runId === runId;
        } catch {
          return false;
        }
      });
    },

    saveRun(row: RunRow): void {
      db.prepare(
        `insert into run (runId, flowName, path, status, startedAt, endedAt, waitingFor, question, cost, tokens, withJson, startedByJson, error)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(runId) do update set
           status = excluded.status, endedAt = excluded.endedAt, waitingFor = excluded.waitingFor,
           question = excluded.question, cost = excluded.cost, tokens = excluded.tokens,
           withJson = excluded.withJson, startedByJson = excluded.startedByJson, error = excluded.error`,
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
        row.withJson,
        row.startedByJson,
        row.error,
      );
    },

    addEvent(runId: string, event: RunEvent, seq?: number): StoredEvent {
      const stored: StoredEvent = { ...event, at: new Date().toISOString(), seq };
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

    /**
     * Reads every run on disk, so a lost index costs nothing but the events.
     *
     * `all` reads them every one, which is what a daemon does when it starts.
     * Without it, only the runs this index has never seen and the ones it still
     * believes are going: a run started at the command line while the daemon
     * runs is one of those, and the page did not show it at all until a
     * restart, because this ran once and never again.
     */
    index(runs: string, all = true): number {
      let found = 0;
      for (const runId of directories(runs)) {
        if (!all) {
          const held = this.run(runId);
          if (held && held.status !== "running" && held.status !== "waiting") continue;
        }
        const state = stateAt(join(runs, runId, "state.json"));
        if (!state) continue;
        // A run that says it runs, and whose process has gone, is a run that
        // died. A run whose process is alive belongs to that process: the state
        // on disk is the run, and this index must never rewrite a live one.
        // ADR 0008.
        if (state.status === "running" && !alive(state.pid)) {
          state.status = "stopped";
          keep(join(runs, runId), state);
        }
        const row = rowOf(state, this.run(runId)?.path ?? null, metricsAt(join(runs, runId, "trajectory.json")));
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
    withJson: state.with ? JSON.stringify(state.with) : null,
    startedByJson: state.startedBy ? JSON.stringify(state.startedBy) : null,
    error: state.status === "failed" ? (state.error ?? said(state)) : null,
  };
}

/** The failed step's error, under the name of the step that holds it. */
function said(state: RunState): string | null {
  const fault = Object.entries(state.steps).find(([, record]) => record.status === "failed");
  return fault ? `${fault[0]}: ${fault[1].error ?? "failed"}` : null;
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
