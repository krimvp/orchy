import { type CSSProperties, useEffect, useState } from "react";
import { api, useLoad, useNotices } from "./api";
import { Contract } from "./Run";
import { Loading, taken, took, when } from "./Runs";

/**
 * Every run of one flow, and the door to the next one. A flow runs many times,
 * on different values each time, and those runs read as one thing: the list of
 * every run mixes them with every other flow, and the editor says nothing about
 * what the flow did. So the history of a flow lives here, and a person starts
 * another run without leaving the page that shows the ones already on the way.
 */
export function FlowRuns({ id }: { id: number }) {
  const { events, pending } = useNotices();
  const flow = useLoad(() => api.flow(id), [id]);
  const { value: runs, error, again } = useLoad(() => api.flowRuns(id), [id]);
  const [fault, setFault] = useState<string>();
  const [note, setNote] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    again();
  }, [events.length, pending.length, again]);

  const begin = (values?: Record<string, unknown>) => {
    setBusy(true);
    setFault(undefined);
    return api
      .startFlow(id, values)
      .then(() => {
        setNote("It is on its way. Change a value and start another whenever you like.");
        again();
      })
      .catch((problem: Error) => (setNote(undefined), setFault(problem.message)))
      .finally(() => setBusy(false));
  };

  const takes = flow.value?.flow.takes;
  const path = flow.value?.row.path;
  // A ticket whose run has begun already shows as that run, so it shows once.
  const queued = pending.filter(
    (ticket) => ticket.path === path && (ticket.error || !ticket.runId || !runs?.some((run) => run.runId === ticket.runId)),
  );
  const now = runs?.filter((run) => run.status === "waiting" || run.status === "running") ?? [];
  const past = runs?.filter((run) => run.status !== "waiting" && run.status !== "running") ?? [];

  return (
    <section className="stagger">
      <h1>
        {flow.value?.flow.name ?? "…"}
        <a className="button" href={`#/flows/${id}`}>
          Edit the flow
        </a>
      </h1>
      <p className="note mono small" style={{ "--i": 1 } as CSSProperties}>
        {path}
      </p>

      <div className="panel" style={{ "--i": 2 } as CSSProperties}>
        <h3>Start a run</h3>
        {takes ? (
          <>
            <p className="note small">
              The flow takes these values. Fill them, start it, then change one and start another — the runs
              go side by side.
            </p>
            {/* The form keeps what it holds after a start, so the next run is one edit away. */}
            <Contract
              schema={takes}
              label={busy ? "Starting…" : "Start a run"}
              onSend={(values) => void begin(values as Record<string, unknown>)}
            />
          </>
        ) : (
          <>
            <p className="note small">This flow takes no values, so a run needs nothing but the word.</p>
            <button className="go" disabled={busy} onClick={() => void begin()}>
              {busy ? "Starting…" : "Start a run"}
            </button>
          </>
        )}
        {fault && <pre className="bad">{fault}</pre>}
        {note && <p className="good small">{note}</p>}
        <p className="note small" style={{ marginBottom: 0 }}>
          Four runs work at once. Anything past that waits in the queue and starts as one ends.
        </p>
      </div>

      {error && <p className="bad">{error}</p>}
      {!runs && <Loading />}

      {queued.length > 0 && (
        <>
          <h2>In the queue</h2>
          <div className="group">
            {queued.map((ticket) => (
              <div key={ticket.ticket} className="flow-line">
                <span className={`pill ${ticket.error ? "failed" : "running"}`}>
                  {ticket.error ? "did not start" : ticket.runId ? "starting" : "queued"}
                </span>
                <div className="grow">
                  <div className="dim small">{when(ticket.queuedAt)}</div>
                  {ticket.error && <pre className="bad small">{ticket.error}</pre>}
                </div>
                {ticket.error && (
                  <button className="quiet" onClick={() => void api.forget(ticket.ticket).then(again)}>
                    Dismiss
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {now.length > 0 && (
        <>
          <h2>On the way</h2>
          <div className="cards">
            {now.map((run) => (
              <a
                key={run.runId}
                className={`card ${run.status === "waiting" ? "needs-you" : ""}`}
                href={`#/runs/${run.runId}`}
              >
                <div className="top">
                  <span className={`pill ${run.status}`}>{run.status === "waiting" ? "your turn" : "on the way"}</span>
                  <span className="name">{taken(run) ?? "no values"}</span>
                  <span className="dim small">{when(run.startedAt)}</span>
                </div>
                <p className="ask">
                  {run.status === "waiting"
                    ? (run.question ?? `The step ${run.waitingFor ?? ""} waits for an answer.`)
                    : "Running by itself — open it to watch the steps land."}
                </p>
              </a>
            ))}
          </div>
        </>
      )}

      {past.length > 0 && (
        <>
          <h2>Earlier</h2>
          {/* Every run here is of one flow, so the column that named the flow
           * names what the run took instead. That is the whole difference. */}
          <div className="group">
            <div className="head">
              <span>Status</span>
              <span>Values</span>
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
                style={{ "--i": index + 3 } as CSSProperties}
              >
                <span>
                  <span className={`pill ${run.status}`}>{run.status}</span>
                </span>
                <span className="name">{taken(run) ?? <em className="need">no values</em>}</span>
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

      {runs?.length === 0 && (
        <p className="empty">This flow has not run yet. Start one above, and it shows up here as it happens.</p>
      )}
    </section>
  );
}
