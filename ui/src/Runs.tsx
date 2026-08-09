import { useEffect } from "react";
import { type RunRow, api, useLoad, useNotices } from "./api";

export function Runs() {
  const { events, pending } = useNotices();
  const { value: runs, error, again } = useLoad(() => api.runs(), []);

  useEffect(() => {
    again();
  }, [events.length, pending.length, again]);

  return (
    <section>
      <h1>Runs</h1>
      {error && <p className="bad">{error}</p>}

      {pending.length > 0 && (
        <table className="rows">
          <thead>
            <tr>
              <th>Waiting to start</th>
              <th>Flow</th>
              <th>Queued</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {pending.map((ticket) => (
              <tr key={ticket.ticket}>
                <td>{ticket.error ? <span className="pill failed">did not start</span> : <span className="pill running">queued</span>}</td>
                <td>{ticket.flowName}</td>
                <td>{when(ticket.queuedAt)}</td>
                <td>
                  {ticket.error && (
                    <>
                      <pre className="bad small">{ticket.error}</pre>
                      <button onClick={() => void api.forget(ticket.ticket).then(again)}>Dismiss</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {runs?.length === 0 && (
        <p className="empty">
          No run yet. Register a flow in <a href="#/flows">Flows</a> and start it.
        </p>
      )}

      {runs && runs.length > 0 && (
        <table className="rows">
          <thead>
            <tr>
              <th>Status</th>
              <th>Flow</th>
              <th>Started</th>
              <th>Took</th>
              <th>Cost</th>
              <th>Tokens</th>
              <th>Run</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.runId} onClick={() => (location.hash = `#/runs/${run.runId}`)}>
                <td>
                  <span className={`pill ${run.status}`}>{run.status}</span>
                </td>
                <td>{run.flowName}</td>
                <td>{when(run.startedAt)}</td>
                <td>{took(run)}</td>
                <td>{run.cost ? `$${run.cost.toFixed(4)}` : "—"}</td>
                <td>{run.tokens ? run.tokens.toLocaleString() : "—"}</td>
                <td className="mono">{run.runId.slice(0, 8)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
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

export function length(millis: number): string {
  const seconds = Math.round(millis / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export type { RunRow };
