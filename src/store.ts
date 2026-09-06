import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { alive, keep, type RunEvent, type RunState } from "./run.ts";
import { ownerLives, processIdentity } from "./claim.ts";

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
create table if not exists start_reservation (
  token text primary key,
  parentRunId text not null,
  step text not null,
  ownerPid integer not null,
  ownerIdentity text not null,
  createdAt text not null,
  childRunId text,
  ownerKind text not null default 'door',
  phase text not null default 'unknown',
  workTicket integer
);
create table if not exists accepted_work (
  ticket integer primary key,
  version integer not null,
  kind text not null,
  status text not null,
  flowName text not null,
  path text not null,
  harness text not null,
  queuedAt text not null,
  runId text,
  plannedRunId text,
  payloadJson text not null,
  reservation text unique,
  acceptedRevision integer,
  ownerPid integer,
  ownerIdentity text,
  error text
);
create unique index if not exists one_active_resume
  on accepted_work(runId)
  where kind = 'resume' and status in ('queued', 'claimed');
create unique index if not exists one_planned_start
  on accepted_work(plannedRunId)
  where kind = 'start';
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

export type WorkStatus = "queued" | "claimed" | "delivered" | "failed";

export interface WorkRow {
  ticket: number;
  version: number;
  kind: "start" | "resume";
  status: WorkStatus;
  flowName: string;
  path: string;
  harness: string;
  queuedAt: string;
  runId: string | null;
  plannedRunId: string | null;
  payloadJson: string;
  reservation: string | null;
  acceptedRevision: number | null;
  ownerPid: number | null;
  ownerIdentity: string | null;
  error: string | null;
}

export type WorkPayload =
  | { kind: "start"; with?: Record<string, unknown>; startedBy?: { runId: string; step: string } }
  | { kind: "resume"; hasValue: boolean; value?: unknown; from?: string; gate?: string };

export type WorkInput =
  | {
      kind: "start";
      flowName: string;
      path: string;
      harness: string;
      plannedRunId: string;
      payload: Extract<WorkPayload, { kind: "start" }>;
      reservation?: string;
    }
  | {
      kind: "resume";
      flowName: string;
      path: string;
      harness: string;
      runId: string;
      acceptedRevision: number;
      payload: Extract<WorkPayload, { kind: "resume" }>;
    };

const WORK_VERSION = 1;
const WORK_PAYLOAD_BYTES = 1_000_000;

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
  const reservationColumns = db.prepare("pragma table_info(start_reservation)").all() as Array<{ name: string }>;
  if (!reservationColumns.some((held) => held.name === "childRunId")) {
    db.exec("alter table start_reservation add column childRunId text");
  }
  if (!reservationColumns.some((held) => held.name === "ownerKind")) {
    db.exec("alter table start_reservation add column ownerKind text not null default 'door'");
  }
  if (!reservationColumns.some((held) => held.name === "phase")) {
    // A reservation from an older Orchy may already have spawned a child. It
    // starts as unknown and stays fail closed when its owner is gone.
    db.exec("alter table start_reservation add column phase text not null default 'unknown'");
  }
  if (!reservationColumns.some((held) => held.name === "workTicket")) {
    db.exec("alter table start_reservation add column workTicket integer");
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

    /**
     * Records accepted work before its caller reports success. When a schedule
     * supplied the work, its due check, receipt, and timestamp are one write.
     */
    acceptWork(input: WorkInput, scheduled?: { flowId: number; at: string }): WorkRow | undefined {
      const payloadJson = encodeWork(input.payload);
      db.exec("begin immediate");
      try {
        if (scheduled) {
          const schedule = one<ScheduleRow>("select * from schedule where flowId = ?", scheduled.flowId);
          if (!schedule || !due(schedule, new Date(scheduled.at))) {
            db.exec("commit");
            return undefined;
          }
        }
        const queuedAt = scheduled?.at ?? new Date().toISOString();
        const inserted = db
          .prepare(
            `insert into accepted_work
               (version, kind, status, flowName, path, harness, queuedAt, runId, plannedRunId,
                payloadJson, reservation, acceptedRevision)
             values (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            WORK_VERSION,
            input.kind,
            input.flowName,
            input.path,
            input.harness,
            queuedAt,
            input.kind === "resume" ? input.runId : null,
            input.kind === "start" ? input.plannedRunId : null,
            payloadJson,
            input.kind === "start" ? (input.reservation ?? null) : null,
            input.kind === "resume" ? input.acceptedRevision : null,
          );
        const ticket = Number(inserted.lastInsertRowid);
        if (input.kind === "start" && input.reservation) {
          const linked = db
            .prepare(
              `update start_reservation set phase = 'accepted', workTicket = ?
               where token = ? and phase = 'reserved'`,
            )
            .run(ticket, input.reservation);
          if (linked.changes !== 1) throw new Error(`the start reservation ${input.reservation} is not available`);
        }
        const saved = one<WorkRow>("select * from accepted_work where ticket = ?", ticket) as WorkRow;
        payloadOf(saved);
        if (scheduled) {
          db.prepare("update schedule set lastAt = ? where flowId = ?").run(scheduled.at, scheduled.flowId);
        }
        db.exec("commit");
        return saved;
      } catch (error) {
        try {
          db.exec("rollback");
        } catch {}
        throw error;
      }
    },

    works: (): WorkRow[] => all<WorkRow>("select * from accepted_work order by ticket"),

    work: (ticket: number): WorkRow | undefined =>
      one<WorkRow>("select * from accepted_work where ticket = ?", ticket),

    /** One process owns dispatch before it can spawn a child. */
    claimWork(ticket: number): WorkRow | undefined {
      db.exec("begin immediate");
      try {
        const claimed = db
          .prepare(
            `update accepted_work set status = 'claimed', ownerPid = ?, ownerIdentity = ?
             where ticket = ? and status = 'queued'`,
          )
          .run(process.pid, processIdentity(), ticket);
        const row = claimed.changes === 1 ? one<WorkRow>("select * from accepted_work where ticket = ?", ticket) : undefined;
        db.exec("commit");
        return row;
      } catch (error) {
        try {
          db.exec("rollback");
        } catch {}
        throw error;
      }
    },

    deliveredWork(ticket: number, runId: string): void {
      db.prepare(
        `update accepted_work set status = 'delivered', runId = ?
         where ticket = ? and status = 'claimed' and ownerPid = ? and ownerIdentity = ?`,
      ).run(runId, ticket, process.pid, processIdentity());
    },

    /** Marks delivery only after the caller found the exact planned run. */
    recoverDeliveredWork(ticket: number, runId: string): void {
      db.prepare(
        `update accepted_work set status = 'delivered', runId = ?
         where ticket = ? and kind = 'start' and status = 'claimed' and plannedRunId = ?`,
      ).run(runId, ticket, runId);
    },

    /** Fails work only while no process owns it, and frees its unused slot. */
    failQueuedWork(ticket: number, error: string): boolean {
      db.exec("begin immediate");
      try {
        const row = one<WorkRow>("select * from accepted_work where ticket = ? and status = 'queued'", ticket);
        if (!row) {
          db.exec("commit");
          return false;
        }
        db.prepare(
          `update accepted_work set status = 'failed', error = ?, ownerPid = null, ownerIdentity = null
           where ticket = ? and status = 'queued'`,
        ).run(error, ticket);
        if (row.reservation) db.prepare("delete from start_reservation where token = ?").run(row.reservation);
        db.exec("commit");
        return true;
      } catch (caught) {
        try {
          db.exec("rollback");
        } catch {}
        throw caught;
      }
    },

    /** Records a refusal found after claim but before any child can start. */
    failOwnedBeforeSpawn(ticket: number, error: string): boolean {
      db.exec("begin immediate");
      try {
        const row = one<WorkRow>(
          `select * from accepted_work
           where ticket = ? and status = 'claimed' and ownerPid = ? and ownerIdentity = ?`,
          ticket,
          process.pid,
          processIdentity(),
        );
        if (!row) {
          db.exec("commit");
          return false;
        }
        db.prepare(
          `update accepted_work set status = 'failed', error = ?, ownerPid = null, ownerIdentity = null
           where ticket = ? and status = 'claimed' and ownerPid = ? and ownerIdentity = ?`,
        ).run(error, ticket, process.pid, processIdentity());
        if (row.reservation) db.prepare("delete from start_reservation where token = ?").run(row.reservation);
        db.exec("commit");
        return true;
      } catch (caught) {
        try {
          db.exec("rollback");
        } catch {}
        throw caught;
      }
    },

    /** Cancels this dispatcher's resume before it can reach a child. */
    cancelOwnedWork(ticket: number): boolean {
      const removed = db.prepare(
        `delete from accepted_work
         where ticket = ? and kind = 'resume' and status = 'claimed' and ownerPid = ? and ownerIdentity = ?`,
      ).run(ticket, process.pid, processIdentity());
      return removed.changes === 1;
    },

    /** Fails work only when this process still owns its dispatch. */
    failOwnedWork(ticket: number, error: string): void {
      db.prepare(
        `update accepted_work set status = 'failed', error = ?, ownerPid = null, ownerIdentity = null
         where ticket = ? and status = 'claimed' and ownerPid = ? and ownerIdentity = ?`,
      ).run(error, ticket, process.pid, processIdentity());
    },

    /** Relinquishes one spawned receipt after this dispatcher stops observing it. */
    orphanOwnedWork(ticket: number): boolean {
      const changed = db.prepare(
        `update accepted_work set ownerIdentity = 'closed:' || ownerIdentity
         where ticket = ? and status in ('claimed', 'delivered') and ownerPid = ? and ownerIdentity = ?`,
      ).run(ticket, process.pid, processIdentity());
      return changed.changes === 1;
    },

    finishWork(ticket: number): void {
      db.prepare("delete from accepted_work where ticket = ?").run(ticket);
    },

    /** Cancels queued continuations before a stop changes their run. */
    cancelQueuedResumes(runId: string): number[] {
      db.exec("begin immediate");
      try {
        const rows = all<{ ticket: number }>(
          "select ticket from accepted_work where kind = 'resume' and runId = ? and status = 'queued'",
          runId,
        );
        db.prepare("delete from accepted_work where kind = 'resume' and runId = ? and status = 'queued'").run(runId);
        db.exec("commit");
        return rows.map((row) => row.ticket);
      } catch (error) {
        try {
          db.exec("rollback");
        } catch {}
        throw error;
      }
    },

    /**
     * A pending receipt cannot disappear while it may still run. A dead owner
     * may be acknowledged, but this does not free a child reservation.
     */
    forgetWork(ticket: number): void {
      db.exec("begin immediate");
      try {
        const row = one<WorkRow>("select * from accepted_work where ticket = ?", ticket);
        if (!row) {
          db.exec("commit");
          return;
        }
        const uncertain =
          row.status === "claimed" &&
          (row.ownerPid === null ||
            row.ownerIdentity === null ||
            !ownerLives({ pid: row.ownerPid, identity: row.ownerIdentity }));
        if (row.status !== "failed" && !uncertain) {
          throw new Error(`ticket ${ticket} is ${row.status}, so it cannot be dismissed`);
        }
        db.prepare("delete from accepted_work where ticket = ?").run(ticket);
        db.exec("commit");
      } catch (error) {
        try {
          db.exec("rollback");
        } catch {}
        throw error;
      }
    },

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

    /** Atomically holds one child slot across every daemon over this root. */
    reserveStart(
      parentRunId: string,
      step: string,
      most: number,
      token: string,
      childRunId?: string,
    ): { accepted: boolean; count: number } {
      db.exec("begin immediate");
      try {
        const held = all<{
          token: string;
          ownerPid: number;
          ownerIdentity: string;
          childRunId: string | null;
          ownerKind: string;
          phase: string;
          workTicket: number | null;
        }>(
          "select token, ownerPid, ownerIdentity, childRunId, ownerKind, phase, workTicket from start_reservation",
        );
        for (const reservation of held) {
          const indexed = reservation.childRunId && this.run(reservation.childRunId);
          const dead = !ownerLives({ pid: reservation.ownerPid, identity: reservation.ownerIdentity });
          const work = reservation.workTicket === null ? undefined : this.work(reservation.workTicket);
          // A new reservation that never reached durable acceptance cannot
          // have spawned. Accepted and legacy reservations stay fail closed
          // when a child may exist. A dead child with no run cannot start later.
          const beforeAcceptance = reservation.phase === "reserved" && !work;
          if (indexed || (dead && (beforeAcceptance || reservation.ownerKind === "child"))) {
            db.prepare("delete from start_reservation where token = ?").run(reservation.token);
          }
        }
        const runs = one<{ count: number }>(
          `select count(*) as count from run
           where json_extract(startedByJson, '$.runId') = ? and json_extract(startedByJson, '$.step') = ?`,
          parentRunId,
          step,
        )?.count ?? 0;
        const reservations = one<{ count: number }>(
          "select count(*) as count from start_reservation where parentRunId = ? and step = ?",
          parentRunId,
          step,
        )?.count ?? 0;
        const count = runs + reservations;
        if (count >= most) {
          db.exec("commit");
          return { accepted: false, count };
        }
        db.prepare(
          `insert into start_reservation
             (token, parentRunId, step, ownerPid, ownerIdentity, createdAt, childRunId, ownerKind)
           values (?, ?, ?, ?, ?, ?, ?, 'door')`,
        ).run(token, parentRunId, step, process.pid, processIdentity(), new Date().toISOString(), childRunId ?? null);
        db.prepare("update start_reservation set phase = 'reserved' where token = ?").run(token);
        db.exec("commit");
        return { accepted: true, count };
      } catch (error) {
        try {
          db.exec("rollback");
        } catch {}
        throw error;
      }
    },

    releaseStart(token: string): void {
      db.prepare("delete from start_reservation where token = ?").run(token);
    },

    /** Transfers a reservation from the daemon to the child that owns the start. */
    attachStart(token: string, runId: string, pid: number, identity: string): void {
      db.prepare(
        "update start_reservation set childRunId = ?, ownerPid = ?, ownerIdentity = ?, ownerKind = 'child' where token = ?",
      ).run(runId, pid, identity, token);
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
    index(runs: string, all = true, stopping = new Set<string>()): number {
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
        if (state.status === "running" && !stopping.has(runId) && !alive(state.pid, state.processGroup)) {
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
    startedAt:
      state.startedAt ??
      records.map((record) => record.startedAt).sort()[0] ??
      (times[0] as string) ??
      new Date().toISOString(),
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

/** Reads one accepted payload. A corrupt receipt is reported and never run. */
export function payloadOf(row: WorkRow): WorkPayload {
  validateWorkRow(row);
  return decodePayload(row.version, row.kind, row.payloadJson);
}

function decodePayload(version: number, kind: unknown, payloadJson: string): WorkPayload {
  if (version !== WORK_VERSION) throw new Error(`accepted work has the unsupported version ${version}`);
  if (Buffer.byteLength(payloadJson) > WORK_PAYLOAD_BYTES) {
    throw new Error(`accepted work is larger than ${WORK_PAYLOAD_BYTES} bytes`);
  }
  let value: unknown;
  try {
    value = JSON.parse(payloadJson);
  } catch {
    throw new Error("accepted work holds malformed JSON");
  }
  if (!record(value) || value.kind !== kind) throw new Error("accepted work holds the wrong payload kind");
  if (kind === "start") {
    exactKeys(value, ["kind", "with", "startedBy"], "accepted start");
    if (value.with !== undefined && !record(value.with)) throw new Error("accepted start values are not an object");
    if (
      value.startedBy !== undefined &&
      (!record(value.startedBy) || typeof value.startedBy.runId !== "string" || typeof value.startedBy.step !== "string")
    ) {
      throw new Error("accepted start ownership is not valid");
    }
    return value as WorkPayload;
  }
  if (kind !== "resume") throw new Error(`accepted work has the invalid kind ${String(kind)}`);
  exactKeys(value, ["kind", "hasValue", "value", "from", "gate"], "accepted resume");
  if (typeof value.hasValue !== "boolean") throw new Error("accepted resume does not say whether it holds a value");
  if (value.from !== undefined && typeof value.from !== "string") throw new Error("accepted resume has an invalid step");
  if (value.gate !== undefined && typeof value.gate !== "string") throw new Error("accepted resume has an invalid gate");
  if (value.hasValue) {
    if (!("value" in value)) throw new Error("accepted resume says its value is missing");
    if (value.from !== undefined) throw new Error("accepted resume holds both a value and a step");
    if (value.gate === undefined) throw new Error("accepted gate answer does not name its gate");
  } else if ("value" in value || value.gate !== undefined) {
    throw new Error("accepted resume holds a value or gate while it says it has no value");
  }
  return value as WorkPayload;
}

function validateWorkRow(row: WorkRow): void {
  const kind: unknown = row.kind;
  const status: unknown = row.status;
  if (kind !== "start" && kind !== "resume") throw new Error(`accepted work has the invalid kind ${String(kind)}`);
  if (!(["queued", "claimed", "delivered", "failed"] as unknown[]).includes(status)) {
    throw new Error(`accepted work has the invalid status ${String(status)}`);
  }
  if (!Number.isInteger(row.ticket) || row.ticket < 1) throw new Error("accepted work has an invalid ticket");
  if (!row.flowName || !row.path || !row.harness || !Number.isFinite(Date.parse(row.queuedAt))) {
    throw new Error("accepted work has invalid identifying fields");
  }
  const owned = row.ownerPid !== null || row.ownerIdentity !== null;
  if (owned && (!Number.isInteger(row.ownerPid) || (row.ownerPid as number) < 1 || !row.ownerIdentity)) {
    throw new Error("accepted work has incomplete owner fields");
  }
  if ((status === "claimed" || status === "delivered") !== owned) {
    throw new Error(`accepted ${String(status)} work has inconsistent owner fields`);
  }
  if (status === "failed" ? !row.error : row.error !== null) {
    throw new Error(`accepted ${String(status)} work has an inconsistent error`);
  }
  if (kind === "start") {
    if (!row.plannedRunId || row.acceptedRevision !== null) {
      throw new Error("accepted start has inconsistent run fields");
    }
    if (row.runId !== null && (status !== "delivered" || row.runId !== row.plannedRunId)) {
      throw new Error("accepted start has an inconsistent delivered run");
    }
  } else if (
    !row.runId ||
    row.plannedRunId !== null ||
    row.reservation !== null ||
    !Number.isInteger(row.acceptedRevision) ||
    (row.acceptedRevision as number) < 0
  ) {
    throw new Error("accepted resume has inconsistent run fields");
  }
}

function encodeWork(payload: WorkPayload): string {
  let json: string;
  try {
    json = JSON.stringify(payload);
  } catch (error) {
    throw new Error(`accepted work is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (json === undefined) throw new Error("accepted work is not JSON");
  if (Buffer.byteLength(json) > WORK_PAYLOAD_BYTES) {
    throw new Error(`accepted work is larger than ${WORK_PAYLOAD_BYTES} bytes`);
  }
  // Read what was written before success can reach the caller.
  decodePayload(WORK_VERSION, payload.kind, json);
  return json;
}

function exactKeys(value: Record<string, unknown>, allowed: string[], at: string): void {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra) throw new Error(`${at} holds the unknown field "${extra}"`);
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
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
