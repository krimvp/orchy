import { useCallback, useEffect, useRef, useState } from "react";

export type Schema = Record<string, unknown>;

export interface Member {
  name: string;
  harness?: string;
  model?: string;
  prompt?: string;
  tools?: string[];
  module?: string;
}

export interface Cycle {
  to: string;
  when: Record<string, unknown>;
  limit: number;
  policy: "escalate" | "accept";
}

export interface Step {
  id: string;
  kind: "agent" | "call" | "gate" | "flow";
  needs: string[];
  prompt?: string;
  module?: string;
  question?: string;
  flow?: string;
  tools?: string[];
  harness?: string;
  model?: string;
  changes?: false;
  returns?: Schema;
  cycle?: Cycle;
  fanout?: Member[];
}

export type Workspace = { kind: "none" } | { kind: "git"; path: string };

export interface Flow {
  name: string;
  workspace?: Workspace;
  parallel?: number;
  steps: Step[];
}

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

export interface Ticket {
  ticket: number;
  flowName: string;
  path: string;
  queuedAt: string;
  runId?: string;
  error?: string;
}

export interface StepRecord {
  status: "done" | "failed";
  startedAt: string;
  endedAt: string;
  value?: unknown;
  error?: string;
  trajectory?: string;
  answeredByPerson?: boolean;
  disagreement?: "accepted";
  changed?: string[];
  cost?: number;
}

export interface RunState {
  runId: string;
  flow: Flow;
  status: string;
  waitingFor?: string;
  question?: string;
  steps: Record<string, StepRecord>;
  cycles: Record<string, number>;
  history?: Array<{ step: string; record: StepRecord }>;
}

export interface Health {
  root: string;
  adapters: string[];
  tools: string[];
}

export type RunEvent = { type: string; at: string } & Record<string, unknown>;

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
  flow: (id: number) =>
    call<{ row: FlowRow; flow: Flow; problems: string[]; editable: boolean }>(`/api/flows/${id}`),
  saveFlow: (id: number, flow: Flow) =>
    call<{ problems: string[]; saved: boolean }>(`/api/flows/${id}`, {
      method: "PUT",
      body: JSON.stringify({ flow }),
    }),
  removeFlow: (id: number) => call<unknown>(`/api/flows/${id}`, { method: "DELETE" }),
  startFlow: (id: number) => call<Ticket>(`/api/flows/${id}/runs`, { method: "POST", body: "{}" }),
  validate: (flow: Flow) =>
    call<{ problems: string[] }>("/api/validate", { method: "POST", body: JSON.stringify({ flow }) }),
  runs: () => call<RunRow[]>("/api/runs"),
  run: (runId: string) => call<{ row: RunRow | null; state: RunState }>(`/api/runs/${runId}`),
  trajectory: (runId: string) => call<Record<string, unknown>>(`/api/runs/${runId}/trajectory`),
  resume: (runId: string, value: unknown) =>
    call<Ticket>(`/api/runs/${runId}/resume`, { method: "POST", body: JSON.stringify({ value }) }),
  stop: (runId: string) => call<{ stopped: boolean }>(`/api/runs/${runId}/stop`, { method: "POST" }),
  queue: () => call<Ticket[]>("/api/queue"),
  forget: (ticket: number) => call<unknown>(`/api/queue/${ticket}`, { method: "DELETE" }),
};

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
