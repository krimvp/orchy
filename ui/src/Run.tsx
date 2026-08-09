import { type CSSProperties, useEffect, useState } from "react";
import { type RunEvent, type RunState, type Schema, type Step, type StepRecord, api, useLoad, useNotices } from "./api";
import { Graph, type Mark } from "./Graph";
import { Loading, length, when } from "./Runs";

export function Run({ runId }: { runId: string }) {
  const { events } = useNotices(runId);
  const { value, error, again } = useLoad(() => api.run(runId), [runId]);
  const [chosen, setChosen] = useState<string>();
  const [fault, setFault] = useState<string>();

  useEffect(() => {
    again();
  }, [events.length, again]);

  if (error) return <p className="bad">{error}</p>;
  if (!value) return <Loading lines={4} />;

  const { state, row } = value;
  const step = state.flow.steps.find((one) => one.id === chosen);
  const record = chosen ? state.steps[chosen] : undefined;
  const gate = state.waitingFor ? state.flow.steps.find((one) => one.id === state.waitingFor) : undefined;
  const done = Object.values(state.steps).filter((one) => one.status === "done").length;

  return (
    <section className="stagger">
      <h1>
        {state.flow.name}
        <span className={`pill big ${state.status}`}>{state.status}</span>
      </h1>
      <p className="note mono small" style={{ "--i": 1 } as CSSProperties}>
        {runId}
      </p>

      <dl className="tiles" style={{ "--i": 2 } as CSSProperties}>
        <div className="tile">
          <dt>Started</dt>
          <dd style={{ fontSize: 15 }}>{when(row?.startedAt ?? state.runId)}</dd>
        </div>
        <div className="tile">
          <dt>Took</dt>
          <dd>{row?.endedAt ? length(new Date(row.endedAt).getTime() - new Date(row.startedAt).getTime()) : "—"}</dd>
        </div>
        <div className="tile">
          <dt>Steps done</dt>
          <dd>
            {done}
            <span style={{ color: "var(--text-3)" }}>/{state.flow.steps.length}</span>
          </dd>
        </div>
        <div className="tile">
          <dt>Cost</dt>
          <dd>{row?.cost ? `$${row.cost.toFixed(4)}` : "—"}</dd>
        </div>
        <div className="tile">
          <dt>Tokens</dt>
          <dd>{row?.tokens ? row.tokens.toLocaleString() : "—"}</dd>
        </div>
      </dl>

      <div className="row" style={{ "--i": 3 } as CSSProperties}>
        <a className="button" href={`/api/runs/${runId}/trajectory`} target="_blank" rel="noreferrer">
          Read the trajectory
        </a>
        {state.status === "running" && (
          <button className="danger" onClick={() => void api.stop(runId).then(again)}>
            Stop this run
          </button>
        )}
      </div>

      <div className="canvas" style={{ "--i": 4 } as CSSProperties}>
        <Graph steps={state.flow.steps} marks={marksOf(state, events)} selected={chosen} onSelect={setChosen} />
      </div>

      {gate && (
        <Answer
          question={state.question ?? ""}
          schema={(gate as Step).returns ?? {}}
          onSend={(answer) =>
            api
              .resume(runId, answer)
              .then(() => (setFault(undefined), again()))
              .catch((problem: Error) => setFault(problem.message))
          }
        />
      )}
      {fault && <p className="bad">{fault}</p>}

      <div className="split">
        <div>
          <h2>Step</h2>
          {!step && (
            <div className="panel">
              <p className="empty" style={{ margin: 0 }}>
                Choose a step in the drawing to read its value.
              </p>
            </div>
          )}
          {step && (
            <Detail
              key={step.id}
              step={step}
              record={record}
              history={attempts(state, step.id)}
              cycles={state.cycles}
            />
          )}
        </div>
        <div>
          <h2>Events</h2>
          <ul className="log">
            {events.map((event, index) => (
              <li key={index}>
                <time>{new Date(event.at).toLocaleTimeString()}</time>
                <span>{say(event)}</span>
              </li>
            ))}
            {events.length === 0 && <li className="empty">No event yet.</li>}
          </ul>
        </div>
      </div>
    </section>
  );
}

function Detail({
  step,
  record,
  history,
  cycles,
}: {
  step: Step;
  record?: StepRecord;
  history: StepRecord[];
  cycles: Record<string, number>;
}) {
  const back = step.cycle ? cycles[`${step.id}->${step.cycle.to}`] : undefined;
  return (
    <div className="panel">
      <h3>{step.id}</h3>
      <dl>
        <dt>Kind</dt>
        <dd>{step.kind}</dd>
        {step.needs.length > 0 && (
          <>
            <dt>Needs</dt>
            <dd>{step.needs.join(", ")}</dd>
          </>
        )}
        {step.kind === "agent" && (
          <>
            <dt>Harness</dt>
            <dd>
              {step.harness ?? "the default"} {step.model ? `· ${step.model}` : ""}
            </dd>
            <dt>Tools</dt>
            <dd>{step.tools?.join(", ") || "none"}</dd>
          </>
        )}
        {step.changes === false && (
          <>
            <dt>Promise</dt>
            <dd>changes nothing</dd>
          </>
        )}
        {step.cycle && (
          <>
            <dt>Cycle</dt>
            <dd>
              back to {step.cycle.to}, {back ?? 0} of {step.cycle.limit} used
            </dd>
          </>
        )}
        {record && (
          <>
            <dt>Status</dt>
            <dd>
              <span className={`pill ${record.status}`}>{record.status}</span>
              {record.answeredByPerson ? " a person answered" : ""}
              {record.disagreement ? " disagreement accepted" : ""}
            </dd>
            <dt>Took</dt>
            <dd>{length(new Date(record.endedAt).getTime() - new Date(record.startedAt).getTime())}</dd>
          </>
        )}
        {record?.changed && (
          <>
            <dt>Changed</dt>
            <dd className="mono small">{record.changed.join(", ")}</dd>
          </>
        )}
      </dl>
      {record?.error && <pre className="bad">{record.error}</pre>}
      {record && "value" in record && <pre>{JSON.stringify(record.value, null, 2)}</pre>}
      {!record && <p className="empty">This step has not ended yet.</p>}
      {history.length > 0 && (
        <details>
          <summary>
            {history.length} attempt{history.length === 1 ? "" : "s"} that a cycle dropped
          </summary>
          {history.map((one, index) => (
            <pre key={index} className="small">
              {JSON.stringify(one.value, null, 2)}
            </pre>
          ))}
        </details>
      )}
    </div>
  );
}

/** A form for the contract of the gate, so a person answers without writing JSON. */
function Answer({
  question,
  schema,
  onSend,
}: {
  question: string;
  schema: Schema;
  onSend: (value: unknown) => void;
}) {
  const properties = (schema.properties ?? {}) as Record<string, Schema>;
  const [value, setValue] = useState<Record<string, unknown>>(() => blank(properties));
  const [raw, setRaw] = useState(false);
  const [text, setText] = useState(() => JSON.stringify(blank(properties), null, 2));

  const set = (key: string, next: unknown) => setValue((held) => ({ ...held, [key]: next }));

  return (
    <div className="panel gate">
      <h2>This run waits for a person</h2>
      <h3 style={{ marginBottom: 18 }}>{question}</h3>
      {!raw &&
        Object.entries(properties).map(([key, field]) => (
          <label key={key} className={field.type === "boolean" ? "field tick" : "field"}>
            {field.type === "boolean" && (
              <input type="checkbox" checked={Boolean(value[key])} onChange={(e) => set(key, e.target.checked)} />
            )}
            <span>{key}</span>
            {(field.type === "number" || field.type === "integer") && (
              <input type="number" value={String(value[key] ?? 0)} onChange={(e) => set(key, Number(e.target.value))} />
            )}
            {field.type === "string" && (
              <input value={String(value[key] ?? "")} onChange={(e) => set(key, e.target.value)} />
            )}
            {field.type === "array" && (
              <textarea
                rows={3}
                placeholder="one for each line"
                value={((value[key] as string[]) ?? []).join("\n")}
                onChange={(e) => set(key, e.target.value.split("\n").filter(Boolean))}
              />
            )}
          </label>
        ))}
      {raw && <textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} />}
      <div className="row" style={{ marginBottom: 0 }}>
        <button className="go" onClick={() => onSend(raw ? JSON.parse(text) : value)}>
          Answer and continue
        </button>
        <button
          className="quiet"
          onClick={() => {
            if (!raw) setText(JSON.stringify(value, null, 2));
            setRaw(!raw);
          }}
        >
          {raw ? "Use the form" : "Write JSON"}
        </button>
      </div>
    </div>
  );
}

function blank(properties: Record<string, Schema>): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(properties)) {
    if (field.type === "boolean") value[key] = false;
    else if (field.type === "number" || field.type === "integer") value[key] = 0;
    else if (field.type === "array") value[key] = [];
    else if (field.type === "object") value[key] = {};
    else value[key] = "";
  }
  return value;
}

function marksOf(state: RunState, events: RunEvent[]): Record<string, Mark> {
  const marks: Record<string, Mark> = {};
  for (const step of state.flow.steps) marks[step.id] = "idle";
  for (const [id, record] of Object.entries(state.steps)) marks[id] = record.status;

  const live = new Set<string>();
  for (const event of events) {
    if (event.type === "step_start") live.add(event.step as string);
    if (event.type === "step_end") live.delete(event.step as string);
  }
  for (const id of live) marks[id] = "running";
  if (state.waitingFor) marks[state.waitingFor] = "waiting";
  return marks;
}

function attempts(state: RunState, id: string): StepRecord[] {
  return (state.history ?? []).filter((one) => one.step === id).map((one) => one.record);
}

function say(event: RunEvent): string {
  switch (event.type) {
    case "run_start":
      return "the run started";
    case "step_start":
      return `${String(event.step)} started`;
    case "step_end":
      return `${String(event.step)} ended ${String(event.status)}`;
    case "cycle":
      return `${String(event.step)} goes back to ${String(event.to)} (${String(event.count)})`;
    case "waiting":
      return `${String(event.step)} waits for a person`;
    case "run_end":
      return `the run is ${String(event.status)}`;
    default:
      return event.type;
  }
}
