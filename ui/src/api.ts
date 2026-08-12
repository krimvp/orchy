import { useCallback, useEffect, useRef, useState } from "react";

export type Schema = Record<string, unknown>;

export interface Member {
  name: string;
  harness?: string;
  model?: string;
  prompt?: string;
  tools?: string[];
  module?: string;
  command?: string;
  with?: Record<string, unknown>;
}

export interface Cycle {
  to: string;
  /** A match against the value of the step, or the word `failed`. */
  when: Record<string, unknown> | "failed";
  limit: number;
  policy: "escalate" | "accept";
}

/**
 * What a step promises to change in the workspace. `paths` names the only paths
 * it changes, and `except` names the paths it must not change.
 */
export type Changes = "nothing" | { paths: string[] } | { except: string[] };

/** One path that a step changed, and what it did to that path. */
export interface Change {
  path: string;
  how: "added" | "changed" | "deleted" | "renamed" | "restored" | "moved";
}

/**
 * Where a fanout finds its list when a step computes it: the step that holds
 * the value, and the key in that value. The run expands this one.
 */
export interface Computed {
  step: string;
  key: string;
}

/** The members a file names, or where the run finds them. */
export type Fanout = Member[] | Computed;

export interface Step {
  id: string;
  kind: "agent" | "call" | "gate" | "flow";
  needs: string[];
  /** Runs the step only when the value of each step named here matches. */
  when?: Record<string, Record<string, unknown>>;
  prompt?: string;
  module?: string;
  command?: string;
  question?: string;
  flow?: string;
  tools?: string[];
  harness?: string;
  model?: string;
  /** What a step that holds the `orchy` tool may start. The door enforces it. */
  starts?: { flows?: string[]; most?: number };
  with?: Record<string, unknown>;
  /** The values that must reach the step, as JSON Schema. */
  takes?: Schema;
  changes?: Changes;
  returns?: Schema;
  cycle?: Cycle;
  fanout?: Fanout;
}

/** The members a file names, or nothing when a step computes the list. */
export function membersOf(step: Step): Member[] | undefined {
  return Array.isArray(step.fanout) ? step.fanout : undefined;
}

/** Where the run finds the list, or nothing when the file names the members. */
export function computedOf(step: Step): Computed | undefined {
  return step.fanout && !Array.isArray(step.fanout) ? step.fanout : undefined;
}

export type Workspace = { kind: "none" } | { kind: "git"; path: string };

export interface Flow {
  name: string;
  workspace?: Workspace;
  /** The harness and the model for a step that names neither. */
  harness?: string;
  model?: string;
  /** The promise for an agent step and a call step that declares none. */
  changes?: Changes;
  /** The values a run supplies. Every step of the run reads them. */
  takes?: Schema;
  /** The value the flow produces, which is the value of the step it ends with. */
  returns?: Schema;
  /** What the run may spend, in dollars. A run that reaches it stops. */
  budget?: number;
  parallel?: number;
  steps: Step[];
}

export interface FlowRow {
  id: number;
  path: string;
  name: string;
  harness: string;
  addedAt: string;
  /** The leading comment of the flow file, which says what the flow does. */
  description?: string;
  /** The newest run of this flow, so the list says what a run costs. */
  lastRun?: RunRow | null;
  /** The flow runs by itself this often, when set. */
  schedule?: { everyMinutes: number; lastAt: string | null } | null;
  /** The token that starts this flow from a POST, when a webhook holds one. */
  hook?: string | null;
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
  /** The values the run took, as JSON. Two runs of one flow read apart by these. */
  withJson: string | null;
}

export interface Ticket {
  ticket: number;
  flowName: string;
  path: string;
  queuedAt: string;
  runId?: string;
  error?: string;
}

export interface StepRecord {
  status: "done" | "failed" | "skipped";
  startedAt: string;
  endedAt: string;
  value?: unknown;
  error?: string;
  trajectory?: string;
  /** What the step asked, after Orchy read its file and filled every value in. */
  prompt?: string;
  answeredByPerson?: boolean;
  disagreement?: "accepted";
  /** Why a condition ruled the step out. */
  skipped?: string;
  /** The step voted to cycle, and the run acted on a vote to an earlier step. */
  votedToCycle?: string;
  /** Each path the step changed, and what it did to that path. */
  changed?: Change[];
  cost?: number;
}

export interface RunState {
  runId: string;
  flow: Flow;
  /** The values this run supplies for what the flow takes. */
  with?: Record<string, unknown>;
  status: string;
  /** Why the run failed, when the fault belongs to the run and not to one step. */
  error?: string;
  waitingFor?: string;
  question?: string;
  steps: Record<string, StepRecord>;
  /** The value of the step the flow ends with. */
  value?: unknown;
  cycles: Record<string, number>;
  history?: Array<{ step: string; record: StepRecord }>;
}

export interface Metrics {
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens?: number;
  cost_usd?: number;
}

export interface ToolCall {
  tool_call_id: string;
  function_name: string;
  arguments: Record<string, unknown>;
}

/** One turn of a trajectory, in the ATIF format that Orchy writes. */
export interface Turn {
  step_id: number;
  timestamp: string;
  source: "user" | "agent" | "system";
  message: string;
  reasoning_content?: string;
  tool_calls?: ToolCall[];
  observation?: { results: Array<{ source_call_id: string; content: string }> };
  metrics?: Metrics;
  subagent_trajectory_ref?: { trajectory_id: string };
  extra?: {
    orchy?: {
      step: string;
      status: string;
      changed?: Change[];
      disagreement?: string;
      answeredByPerson?: boolean;
      dropped?: boolean;
      startedAt: string;
      endedAt: string;
    };
  };
}

export interface Atif {
  schema_version: string;
  trajectory_id: string;
  agent: { name: string; version: string; model_name: string };
  steps: Turn[];
  subagent_trajectories?: Atif[];
  final_metrics: Metrics & { total_steps: number };
}

/** One operator of a match, as the daemon names it. */
export interface Operator {
  name: string;
  /** What the operator holds: the value itself, a boolean, or a number. */
  reads: "value" | "boolean" | "number";
}

export interface Health {
  root: string;
  adapters: string[];
  tools: string[];
  /** The operators a match holds. The page draws them, and holds no copy. */
  operators: Operator[];
  /** What a model name looks like, for each harness. The editor hints with it. */
  models?: Record<string, string>;
}

/**
 * The one operator that a match names, or nothing when the match is a plain
 * value or a shape that no operator holds. The daemon supplies the set, so the
 * page states no rule about it.
 */
export function operatorOf(wanted: unknown, operators: Operator[]): [Operator, unknown] | undefined {
  if (typeof wanted !== "object" || wanted === null || Array.isArray(wanted)) return undefined;
  const entries = Object.entries(wanted as Record<string, unknown>);
  const [first] = entries;
  if (entries.length !== 1 || !first) return undefined;
  const operator = operators.find((one) => one.name === first[0]);
  return operator && [operator, first[1]];
}

export type RunEvent = { type: string; at: string } & Record<string, unknown>;

/**
 * The editor holds this while its flow differs from the file, and the router
 * reads it before it leaves the page. One flag, because one editor is open.
 */
export const unsaved = { here: false };

export type Notice = { kind: "event"; runId: string; event: RunEvent } | { kind: "queue"; pending: Ticket[] };

async function call<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: options?.body ? { "content-type": "application/json" } : undefined,
  });
  const value = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? `the daemon answered ${response.status}`);
  return value;
}

export const api = {
  health: () => call<Health>("/api/health"),
  flows: () => call<FlowRow[]>("/api/flows"),
  addFlow: (path: string, harness: string) =>
    call<FlowRow>("/api/flows", { method: "POST", body: JSON.stringify({ path, harness }) }),
  /** Scaffolds a new flow file with one step and its prompt, and registers it. */
  newFlow: (name: string, harness: string, path?: string) =>
    call<FlowRow>("/api/flows/new", { method: "POST", body: JSON.stringify({ name, harness, path }) }),
  flow: (id: number) =>
    call<{ row: FlowRow; flow: Flow; problems: string[]; warnings: string[]; editable: boolean }>(
      `/api/flows/${id}`,
    ),
  saveFlow: (id: number, flow: Flow) =>
    call<{ problems: string[]; saved: boolean }>(`/api/flows/${id}`, {
      method: "PUT",
      body: JSON.stringify({ flow }),
    }),
  removeFlow: (id: number) => call<unknown>(`/api/flows/${id}`, { method: "DELETE" }),
  /** The flow runs by itself, this often, with these values. */
  setSchedule: (id: number, everyMinutes: number, values?: Record<string, unknown>) =>
    call<{ scheduled: boolean }>(`/api/flows/${id}/schedule`, {
      method: "PUT",
      body: JSON.stringify({ everyMinutes, with: values }),
    }),
  clearSchedule: (id: number) => call<unknown>(`/api/flows/${id}/schedule`, { method: "DELETE" }),
  /** Makes the webhook of a flow, and gives back its token. */
  setHook: (id: number) => call<{ token: string }>(`/api/flows/${id}/hook`, { method: "PUT" }),
  clearHook: (id: number) => call<unknown>(`/api/flows/${id}/hook`, { method: "DELETE" }),
  /** The values the flow takes ride with the request. The child checks them. */
  startFlow: (id: number, values?: Record<string, unknown>) =>
    call<Ticket>(`/api/flows/${id}/runs`, { method: "POST", body: JSON.stringify({ with: values }) }),
  validate: (flow: Flow, path?: string) =>
    call<{ problems: string[]; warnings: string[] }>("/api/validate", {
      method: "POST",
      body: JSON.stringify({ flow, path }),
    }),
  /** A file a flow names: a prompt, a module, an inner flow. The daemon keeps it under its root. */
  file: (path: string) =>
    call<{ path: string; exists: boolean; content: string }>(`/api/file?path=${encodeURIComponent(path)}`),
  writeFile: (path: string, content: string) =>
    call<{ written: boolean; path: string }>("/api/file", { method: "PUT", body: JSON.stringify({ path, content }) }),
  runs: () => call<RunRow[]>("/api/runs"),
  /** The runs of one flow, newest first. */
  flowRuns: (id: number) => call<RunRow[]>(`/api/flows/${id}/runs`),
  run: (runId: string) => call<{ row: RunRow | null; state: RunState }>(`/api/runs/${runId}`),
  trajectory: (runId: string) => call<Atif>(`/api/runs/${runId}/trajectory`),
  /**
   * A value answers a gate. No value continues an ended run, from `from` or
   * where it stood. `step` is the gate the answer was written for, so an answer
   * cannot land on a question that arrived while a person was reading.
   */
  resume: (runId: string, value?: unknown, from?: string, step?: string) =>
    call<Ticket>(`/api/runs/${runId}/resume`, { method: "POST", body: JSON.stringify({ value, from, step }) }),
  stop: (runId: string) =>
    call<{ stopped: boolean; abandoned?: boolean }>(`/api/runs/${runId}/stop`, { method: "POST" }),
  queue: () => call<Ticket[]>("/api/queue"),
  forget: (ticket: number) => call<unknown>(`/api/queue/${ticket}`, { method: "DELETE" }),
};

/**
 * Follows a ticket until its run starts, and lands the person on the run page.
 * A queue that stays full for a while ends the wait on the Runs page instead,
 * so a person is never left in front of the button they already pressed.
 */
export async function follow(ticket: Ticket): Promise<void> {
  for (let turn = 0; turn < 40; turn += 1) {
    const pending = await api.queue().catch(() => [] as Ticket[]);
    const held = pending.find((one) => one.ticket === ticket.ticket);
    // A job leaves the queue when it ends; its run page is the place to read why.
    if (held?.runId || (!held && ticket.runId)) {
      location.hash = `#/runs/${held?.runId ?? ticket.runId}`;
      return;
    }
    if (held?.error) throw new Error(held.error);
    if (!held) break;
    await new Promise((rest) => setTimeout(rest, 500));
  }
  location.hash = "#/";
}

/**
 * Holds the events of one run, or of every run, and the queue. The daemon sends
 * the events of a run again when the stream opens, so a reload loses nothing.
 */
export function useNotices(runId?: string): { events: RunEvent[]; pending: Ticket[] } {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [pending, setPending] = useState<Ticket[]>([]);

  useEffect(() => {
    setEvents([]);
    const source = new EventSource(runId ? `/api/runs/${runId}/events` : "/api/events");
    source.onmessage = (message) => {
      const notice = JSON.parse(message.data as string) as Notice;
      if (notice.kind === "queue") setPending(notice.pending);
      else setEvents((seen) => [...seen, notice.event]);
    };
    return () => source.close();
  }, [runId]);

  return { events, pending };
}

/** Reads once, and again whenever a value in `on` changes. */
export function useLoad<T>(read: () => Promise<T>, on: unknown[]): { value?: T; error?: string; again: () => void } {
  const [value, setValue] = useState<T>();
  const [error, setError] = useState<string>();
  const [count, setCount] = useState(0);
  const held = useRef(read);
  held.current = read;

  useEffect(() => {
    let live = true;
    held
      .current()
      .then((next) => live && (setValue(next), setError(undefined)))
      .catch((fault: Error) => live && setError(fault.message));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...on, count]);

  // One identity, so a caller puts this in the list of an effect without a loop.
  const again = useCallback(() => setCount((n) => n + 1), []);
  return { value, error, again };
}
