import { type CSSProperties, useEffect } from "react";
import { type Change, type RunRow, api, useLoad, useNotices } from "./api";

export function Runs() {
  const { events, pending } = useNotices();
  const { value: runs, error, again } = useLoad(() => api.runs(), []);

  useEffect(() => {
    again();
  }, [events.length, pending.length, again]);

  // A run that needs a person outranks a run that runs by itself.
  const waiting = runs?.filter((run) => run.status === "waiting") ?? [];
  const running = runs?.filter((run) => run.status === "running") ?? [];
  const past = runs?.filter((run) => run.status !== "waiting" && run.status !== "running") ?? [];

  return (
    <section className="stagger">
      <h1>Runs</h1>
      <p className="note" style={{ "--i": 1 } as CSSProperties}>
        {runs ? `${runs.length} run${runs.length === 1 ? "" : "s"}` : "Reading the runs"}
        {running.length > 0 ? ` · ${running.length} on the way` : ""}
        {waiting.length > 0 ? ` · ${waiting.length} waiting for you` : ""}
        {pending.length > 0 ? ` · ${pending.length} in the queue` : ""}
      </p>
      {error && <p className="bad">{error}</p>}

      {waiting.length > 0 && (
        <div className="cards" style={{ "--i": 2 } as CSSProperties}>
          {waiting.map((run) => (
            <a key={run.runId} className="card needs-you" href={`#/runs/${run.runId}`}>
              <div className="top">
                <span className="pill waiting">your turn</span>
                <span className="name">{run.flowName}</span>
                <span className="dim small">{when(run.startedAt)}</span>
              </div>
              <p className="ask">{run.question ?? `The step ${run.waitingFor ?? ""} waits for an answer.`}</p>
              <span className="button go">Answer it</span>
            </a>
          ))}
        </div>
      )}

      {running.length > 0 && (
        <div className="cards" style={{ "--i": 3 } as CSSProperties}>
          {running.map((run) => (
            <a key={run.runId} className="card" href={`#/runs/${run.runId}`}>
              <div className="top">
                <span className="pill running">on the way</span>
                <span className="name">{run.flowName}</span>
                <span className="dim small">{when(run.startedAt)}</span>
              </div>
              <p className="note" style={{ margin: 0 }}>
                Nothing to do — open it to watch the steps land.
              </p>
            </a>
          ))}
        </div>
      )}

      {pending.length > 0 && (
        <div className="group" style={{ "--i": 4 } as CSSProperties}>
          {pending.map((ticket) => (
            <div key={ticket.ticket} className="flow-line">
              <span className={`pill ${ticket.error ? "failed" : "running"}`}>
                {ticket.error ? "did not start" : "queued"}
              </span>
              <div className="grow">
                <div className="name">{ticket.flowName}</div>
                {ticket.error && <pre className="bad small">{ticket.error}</pre>}
              </div>
              <span className="dim small">{when(ticket.queuedAt)}</span>
              {ticket.error && (
                <button className="quiet" onClick={() => void api.forget(ticket.ticket).then(again)}>
                  Dismiss
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {!runs && <Loading />}

      {runs?.length === 0 && (
        <div className="panel">
          <h3>No run yet</h3>
          <p className="note">Register a flow file, then start it. A run shows up here as it happens.</p>
          <a className="button go" href="#/flows">
            Open Flows
          </a>
        </div>
      )}

      {past.length > 0 && (
        <>
          {(waiting.length > 0 || running.length > 0) && <h2>Earlier</h2>}
          <div className="group" style={{ "--i": 5 } as CSSProperties}>
            <div className="head">
              <span>Status</span>
              <span>Flow</span>
              <span>Started</span>
              <span>Took</span>
              <span>Cost</span>
              <span>Tokens</span>
              <span />
            </div>
            {past.map((run, index) => (
              <a
                key={run.runId}
                className="line"
                href={`#/runs/${run.runId}`}
                style={{ "--i": index + 6 } as CSSProperties}
              >
                <span>
                  <span className={`pill ${run.status}`}>{run.status}</span>
                </span>
                <span className="name">{run.flowName}</span>
                <span className="dim">{when(run.startedAt)}</span>
                <span className="dim">{took(run)}</span>
                <span className="dim">{run.cost ? `$${run.cost.toFixed(4)}` : "—"}</span>
                <span className="dim">{run.tokens ? run.tokens.toLocaleString() : "—"}</span>
                <span className="go">›</span>
              </a>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

export function Loading({ lines = 3 }: { lines?: number }) {
  return (
    <div className="group" style={{ padding: 18 }}>
      {Array.from({ length: lines }, (_one, index) => (
        <div key={index} className="skeleton" style={{ width: `${88 - index * 16}%` }} />
      ))}
    </div>
  );
}

export function when(at: string): string {
  const seconds = Math.round((Date.now() - new Date(at).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return new Date(at).toLocaleDateString();
}

export function took(run: { startedAt: string; endedAt: string | null }): string {
  if (!run.endedAt) return "—";
  return length(new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime());
}

/** `deleted docs/x, added docs/y`. The record names the verb, and not only the path. */
export function said(changed: Change[]): string {
  return changed.map((one) => `${one.how} ${one.path}`).join(", ");
}

export function length(millis: number): string {
  const seconds = Math.round(millis / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export type { RunRow };
