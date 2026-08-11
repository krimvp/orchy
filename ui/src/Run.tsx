import { type CSSProperties, useEffect, useRef, useState } from "react";
import {
  type Change,
  type RunEvent,
  type RunState,
  type Schema,
  type Step,
  type StepRecord,
  api,
  follow as followTicket,
  useLoad,
  useNotices,
} from "./api";
import { Graph, type Mark } from "./Graph";
import { Loading, length, said, when } from "./Runs";
import { Trajectory } from "./Trajectory";

export function Run({ runId }: { runId: string }) {
  const { events: all } = useNotices(runId);
  const { value, error, again } = useLoad(() => api.run(runId), [runId]);
  // The flow this run came from, so the other runs of it are one click away.
  const flows = useLoad(() => api.flows(), []);
  const [chosen, setChosen] = useState<string>();
  // Once a person picks a step, the page stops following the run for them.
  const picked = useRef(false);
  const [fault, setFault] = useState<string>();

  // What the run did, and what its steps said while they did it.
  const events = all.filter((event) => event.type !== "output");
  const output = all.filter((event) => event.type === "output");
  const live = liveSteps(events);

  useEffect(() => {
    again();
  }, [events.length, again]);

  // The elapsed times move while the run does. A run whose row says otherwise
  // has no live process, so its clock stands still.
  useTick(value?.state.status === "running" && (!value.row || value.row.status === "running"));

  // The page follows the run: the step that acts is the step that shows.
  const follow = value ? followed(value.state, live) : undefined;
  useEffect(() => {
    if (!picked.current && follow) setChosen(follow);
  }, [follow]);

  if (error) return <p className="bad">{error}</p>;
  if (!value) return <Loading lines={4} />;

  const { state: held, row } = value;
  const sibling = row?.path ? flows.value?.find((one) => one.path === row.path) : undefined;
  // A daemon that died mid-run leaves a state that still says running. The
  // index reconciles at boot, and this guard holds the same line meanwhile.
  const state: RunState =
    held.status === "running" && row && row.status !== "running" ? { ...held, status: row.status } : held;
  const step = state.flow.steps.find((one) => one.id === chosen);
  const record = chosen ? state.steps[chosen] : undefined;
  const gate = state.waitingFor ? state.flow.steps.find((one) => one.id === state.waitingFor) : undefined;
  const marks = marksOf(state, events);
  const pick = (id: string) => {
    picked.current = true;
    setChosen(id);
  };

  return (
    <section className="stagger">
      <h1>
        {state.flow.name}
        <span className={`pill big ${state.status}`}>{state.status}</span>
        {sibling && (
          <a className="button" href={`#/flows/${sibling.id}/runs`} title="Every run of this flow">
            Other runs
          </a>
        )}
      </h1>
      <p className="note mono small" style={{ "--i": 1 } as CSSProperties}>
        {runId}
      </p>

      <Hero
        state={state}
        live={live}
        gate={gate}
        onOpen={pick}
        onAnswer={(answer) =>
          api
            .resume(runId, answer)
            .then(() => (setFault(undefined), again()))
            .catch((problem: Error) => setFault(problem.message))
        }
        onResume={(from) =>
          api
            .resume(runId, undefined, from)
            .then(() => (setFault(undefined), again()))
            .catch((problem: Error) => setFault(problem.message))
        }
      />
      {fault && <p className="bad">{fault}</p>}

      <Progress steps={state.flow.steps} marks={marks} chosen={chosen} onPick={pick} />

      <dl className="tiles" style={{ "--i": 2 } as CSSProperties}>
        <div className="tile">
          <dt>Started</dt>
          <dd style={{ fontSize: 15 }}>{when(row?.startedAt ?? state.runId)}</dd>
        </div>
        <div className="tile">
          <dt>Took</dt>
          <dd>
            {row?.endedAt
              ? length(new Date(row.endedAt).getTime() - new Date(row.startedAt).getTime())
              : row && state.status === "running"
                ? length(Date.now() - new Date(row.startedAt).getTime())
                : "—"}
          </dd>
        </div>
        <div className="tile">
          <dt>Steps done</dt>
          <dd>
            {Object.values(state.steps).filter((one) => one.status === "done").length}
            <span style={{ color: "var(--text-3)" }}>/{state.flow.steps.length}</span>
          </dd>
        </div>
        <div className="tile">
          <dt>Cost</dt>
          <dd>
            {row?.cost ? `$${row.cost.toFixed(4)}` : "—"}
            {/* A budget belongs to the run, so the spend reads against it. */}
            {state.flow.budget !== undefined && (
              <span style={{ color: "var(--text-3)" }}>/${state.flow.budget}</span>
            )}
          </dd>
        </div>
        <div className="tile">
          <dt>Tokens</dt>
          <dd>{row?.tokens ? row.tokens.toLocaleString() : "—"}</dd>
        </div>
      </dl>

      {state.with && (
        <details>
          <summary>The values this run takes</summary>
          <Value value={state.with} />
        </details>
      )}

      <div className="row" style={{ "--i": 3 } as CSSProperties}>
        <a className="button" href={`/api/runs/${runId}/trajectory`} target="_blank" rel="noreferrer">
          Read the trajectory
        </a>
        {/* A person leaves a run at any point before it ends — even at a gate. */}
        {(state.status === "running" || state.status === "waiting") && (
          <button
            className="danger"
            onClick={() =>
              void api
                .stop(runId)
                .then(() => (setFault(undefined), again()))
                .catch((problem: Error) => setFault(problem.message))
            }
          >
            Stop this run
          </button>
        )}
        {(state.status === "done" || state.status === "failed" || state.status === "stopped") && row?.path && (
          <button
            className="button"
            onClick={() =>
              void api
                .flows()
                .then((flows) => {
                  const found = flows.find((one) => one.path === row.path);
                  if (!found) throw new Error("This flow is not registered any more, so register it first.");
                  return api.startFlow(found.id, state.with).then(followTicket);
                })
                .catch((problem: Error) => setFault(problem.message))
            }
          >
            Run it again{state.with ? ", with the same values" : ""}
          </button>
        )}
      </div>

      <div className="canvas" style={{ "--i": 4 } as CSSProperties}>
        <Graph steps={state.flow.steps} marks={marks} selected={chosen} onSelect={pick} />
      </div>

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
              onRerun={
                // A run that ended can go back to a step: the steps before it
                // keep their work, and this one onward runs again.
                state.status === "done" || state.status === "failed" || state.status === "stopped"
                  ? () =>
                      void api
                        .resume(runId, undefined, step.id)
                        .then(() => (setFault(undefined), again()))
                        .catch((problem: Error) => setFault(problem.message))
                  : undefined
              }
            />
          )}
        </div>
        <div>
          <h2>Activity</h2>
          <Activity events={events} output={output} live={state.status === "running"} />
        </div>
      </div>

      <h2>Trajectory</h2>
      {/* Orchy writes the trajectory wherever the run stops, so there is none to ask for yet. */}
      {state.status === "running" ? (
        <p className="empty">
          Orchy writes the trajectory wherever the run stops. Until then, Activity shows the work as it lands.
        </p>
      ) : (
        <Trajectory runId={runId} at={events.length} />
      )}
    </section>
  );
}

/**
 * The one panel that says what happens now and what a person should do about
 * it. Every state of a run answers both questions, so no one reads a log to
 * learn whether to wait.
 */
function Hero({
  state,
  live,
  gate,
  onAnswer,
  onOpen,
  onResume,
}: {
  state: RunState;
  live: Array<{ id: string; since: string }>;
  gate?: Step;
  onAnswer: (value: unknown) => void;
  onOpen: (id: string) => void;
  onResume: (from?: string) => void;
}) {
  if (state.status === "waiting" && gate) {
    // The question reads the steps before it, so their answers stand right here.
    const evidence = gate.needs
      .map((need) => ({ need, record: state.steps[need] }))
      .filter((one) => one.record && "value" in one.record);
    return (
      <div className="hero waiting" style={{ "--i": 1 } as CSSProperties}>
        <span className="badge">Your turn</span>
        <h2>This run waits for you</h2>
        <p className="ask">{state.question ?? gate.question}</p>
        {evidence.map(({ need, record }) => (
          <Value key={need} label={`What ${need} answered`} value={record?.value} />
        ))}
        <Contract schema={gate.returns ?? {}} label="Answer and continue" onSend={onAnswer} />
      </div>
    );
  }

  if (state.status === "running") {
    return (
      <div className="hero running" style={{ "--i": 1 } as CSSProperties}>
        <span className="badge">Working</span>
        <h2>Orchy is working — nothing for you to do</h2>
        <p>
          {live.length === 0
            ? "The next wave of steps is about to start."
            : live.map((one, index) => (
                <span key={one.id}>
                  {index > 0 && ", "}
                  <button className="link" onClick={() => onOpen(one.id)}>
                    {one.id}
                  </button>{" "}
                  <span className="dim">({length(Date.now() - new Date(one.since).getTime())})</span>
                </span>
              ))}
          {live.length === 1 && " is on the way."}
          {live.length > 1 && " are on the way."}
        </p>
      </div>
    );
  }

  if (state.status === "failed") {
    const [id, record] = broken(state) ?? [];
    return (
      <div className="hero failed" style={{ "--i": 1 } as CSSProperties}>
        <span className="badge">Failed</span>
        <h2>This run failed</h2>
        {state.error && <p className="ask">{state.error}</p>}
        {id && record && (
          <>
            <p>
              The step <b>{id}</b> failed.{" "}
              <button className="link" onClick={() => onOpen(id)}>
                Open it
              </button>{" "}
              to read the whole error.
            </p>
            {record.error && <pre className="bad clamp">{record.error}</pre>}
            <div className="row" style={{ marginBottom: 0 }}>
              <button className="go" onClick={() => onResume()}>
                Fix it and resume from {id}
              </button>
              <span className="dim small">The steps that passed keep their work.</span>
            </div>
          </>
        )}
        <Leavings state={state} />
      </div>
    );
  }

  if (state.status === "done") {
    const value = returned(state);
    return (
      <div className="hero done" style={{ "--i": 1 } as CSSProperties}>
        <span className="badge">Done</span>
        <h2>This run is done</h2>
        {value === undefined ? (
          <p>Every step passed. Choose one in the drawing to read what it answered.</p>
        ) : (
          <Value label="It returned this value" value={value} />
        )}
        <Leavings state={state} />
      </div>
    );
  }

  // A state the page does not know, such as killed, still says what holds.
  return (
    <div className="hero" style={{ "--i": 1 } as CSSProperties}>
      <span className="badge">{state.status}</span>
      <h2>This run is {state.status}</h2>
      {state.error && <p className="ask">{state.error}</p>}
      {state.status === "stopped" && (
        <div className="row" style={{ marginBottom: 0 }}>
          <button className="go" onClick={() => onResume()}>
            Resume this run
          </button>
          <span className="dim small">It continues where it stood. The steps that passed keep their work.</span>
        </div>
      )}
    </div>
  );
}

/**
 * One cell for each step, in the order the drawing holds them. The strip says
 * how far the run is at a glance, and each cell opens its step.
 */
function Progress({
  steps,
  marks,
  chosen,
  onPick,
}: {
  steps: Step[];
  marks: Record<string, Mark>;
  chosen?: string;
  onPick: (id: string) => void;
}) {
  const count = (mark: Mark) => steps.filter((one) => marks[one.id] === mark).length;
  const parts = [
    [count("done"), "done"],
    [count("running"), "running"],
    [count("waiting"), "waiting for a person"],
    [count("failed"), "failed"],
    [count("skipped"), "skipped"],
    [count("idle"), "not started"],
  ] as const;

  return (
    <div className="progress" style={{ "--i": 2 } as CSSProperties}>
      <div className="track">
        {steps.map((one) => (
          <button
            key={one.id}
            className={`seg ${marks[one.id] ?? "idle"} ${chosen === one.id ? "chosen" : ""}`}
            title={`${one.id} — ${marks[one.id] ?? "not started"}`}
            onClick={() => onPick(one.id)}
          />
        ))}
      </div>
      <span className="tally">
        {parts
          .filter(([n]) => n > 0)
          .map(([n, word]) => `${n} ${word}`)
          .join(" · ")}
      </span>
    </div>
  );
}

/**
 * Everything the run does, in the order it happens: the life of each step, and
 * what the steps say while they work. One list, so a reader follows one thing.
 */
function Activity({ events, output, live }: { events: RunEvent[]; output: RunEvent[]; live: boolean }) {
  const foot = useRef<HTMLDivElement>(null);
  const rows = [
    ...events.map((event) => ({
      at: event.at,
      seq: Number(event.seq ?? 0),
      step: event.step ? String(event.step) : "",
      kind: kindOf(event),
      text: say(event),
    })),
    ...output.map((note) => ({
      at: note.at,
      seq: Number(note.seq ?? 0),
      step: String(note.step),
      kind: String(note.kind),
      text: String(note.text),
    })),
    // The clock orders the feed, and the order of receipt breaks a tie.
  ].sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq);

  useEffect(() => {
    if (live) foot.current?.scrollIntoView({ block: "nearest" });
  }, [rows.length, live]);

  return (
    <div className="output activity">
      {rows.map((row, index) => (
        <div key={index} className={`note ${row.kind}`}>
          <time>{new Date(row.at).toLocaleTimeString()}</time>
          <span className="step">{row.step}</span>
          {/* A whole file in the feed drowns the story, so a long note folds. */}
          {row.text.length > 600 ? (
            <details className="text long">
              <summary>
                {row.text.slice(0, 160).replaceAll("\n", " ")}… <em>({row.text.length.toLocaleString()} chars)</em>
              </summary>
              {row.text}
            </details>
          ) : (
            <span className="text">{row.text}</span>
          )}
        </div>
      ))}
      {rows.length === 0 && <p className="empty" style={{ padding: "8px 16px" }}>Nothing yet.</p>}
      <div ref={foot} />
    </div>
  );
}

/** An event of the life of a step reads differently from a note it says. */
function kindOf(event: RunEvent): string {
  if (event.type === "step_end" && event.status === "failed") return "event bad-turn";
  if (event.type === "waiting") return "event turn";
  return "event";
}

function Detail({
  step,
  record,
  history,
  cycles,
  onRerun,
}: {
  step: Step;
  record?: StepRecord;
  history: StepRecord[];
  cycles: Record<string, number>;
  onRerun?: () => void;
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
        {step.prompt && (
          <>
            <dt>Prompt</dt>
            {/* The file names the prompt; the run holds the text it really sent,
                with every value filled in. A reader needs the second one. */}
            <dd className="mono small">
              {record?.prompt ? (
                <details className="asked">
                  <summary>{step.prompt}</summary>
                  <pre className="clamp">{record.prompt}</pre>
                </details>
              ) : (
                step.prompt
              )}
            </dd>
          </>
        )}
        {step.module && (
          <>
            <dt>Module</dt>
            <dd className="mono small">{step.module}</dd>
          </>
        )}
        {step.when && (
          <>
            <dt>Runs when</dt>
            <dd>
              {Object.entries(step.when)
                .map(([id, match]) => `${id} says ${JSON.stringify(match)}`)
                .join(", ")}
            </dd>
          </>
        )}
        {step.changes && (
          <>
            <dt>Promise</dt>
            <dd>{promise(step.changes)}</dd>
          </>
        )}
        {step.cycle && (
          <>
            <dt>Loop</dt>
            <dd>
              {step.cycle.when === "failed" ? "retries itself" : `back to ${step.cycle.to}`}, {back ?? 0} of{" "}
              {step.cycle.limit} used
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
              {record.skipped ? ` ${record.skipped}` : ""}
            </dd>
            <dt>Took</dt>
            <dd>{length(new Date(record.endedAt).getTime() - new Date(record.startedAt).getTime())}</dd>
          </>
        )}
        {record?.cost !== undefined && (
          <>
            <dt>Cost</dt>
            <dd>${record.cost.toFixed(4)}</dd>
          </>
        )}
        {/* One wave settles one cycle, so a second vote says what the run left. */}
        {record?.votedToCycle && (
          <>
            <dt>Voted</dt>
            <dd>to go back to {record.votedToCycle}, and the run went elsewhere</dd>
          </>
        )}
        {record?.changed && (
          <>
            <dt>Changed</dt>
            <dd className="mono small">{said(record.changed)}</dd>
          </>
        )}
      </dl>
      {record?.error && (
        <>
          <h4 className="part">What went wrong</h4>
          <pre className="bad">{record.error}</pre>
        </>
      )}
      {record && "value" in record && <Value label="What it answered" value={record.value} />}
      {!record && <p className="empty">This step has not ended yet.</p>}
      {onRerun && record && (
        <div className="row" style={{ marginBottom: 0, marginTop: 12 }}>
          <button className="quiet" onClick={onRerun} title="The steps before this one keep their work.">
            Run again from this step
          </button>
        </div>
      )}
      {history.length > 0 && (
        <details>
          <summary>
            {history.length} attempt{history.length === 1 ? "" : "s"} that a loop dropped
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

/**
 * A value a step answered or a run returned, readable first: prose wraps, JSON
 * pretty-prints and wraps, and one button copies the whole of it.
 */
export function Value({ value, label }: { value: unknown; label?: string }) {
  const [copied, setCopied] = useState(false);
  const prose = proseOf(value);
  const copy = () => {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="value">
      <div className="value-head">
        {label && <span className="dim small">{label}</span>}
        <button className="quiet small" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {prose !== undefined ? (
        <p className="prose">{prose}</p>
      ) : (
        <pre className="wrap">{JSON.stringify(value, null, 2)}</pre>
      )}
    </div>
  );
}

/**
 * The words a value holds, when it is words: a plain string, or an object with
 * one string field. A standup note reads as a note, not as the JSON around it.
 */
function proseOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 1 && typeof entries[0]?.[1] === "string") return entries[0][1];
  }
  return undefined;
}

/**
 * What the run left in the workspace, rolled up across its steps. The files sit
 * uncommitted in the working tree, so the run says so instead of going quiet.
 */
function Leavings({ state }: { state: RunState }) {
  const changed: Change[] = [
    ...Object.values(state.steps),
    ...(state.history ?? []).map((one) => one.record),
  ].flatMap((record) => record.changed ?? []);
  if (changed.length === 0) return null;
  return (
    <details className="leavings">
      <summary>
        It changed {changed.length} {changed.length === 1 ? "path" : "paths"} in the workspace — they sit
        uncommitted
      </summary>
      <pre className="wrap small">{said(changed)}</pre>
    </details>
  );
}

/**
 * A form for a contract, so a person writes no JSON. A gate reads its own
 * contract, and a run that takes values reads what the flow takes. A field the
 * contract needs must hold something before the form sends — a run costs
 * money, and a model asked about nothing answers with nothing.
 */
export function Contract({
  schema,
  label,
  onSend,
}: {
  schema: Schema;
  label: string;
  onSend: (value: unknown) => void;
}) {
  const properties = (schema.properties ?? {}) as Record<string, Schema>;
  const required = (schema.required ?? []) as string[];
  const [value, setValue] = useState<Record<string, unknown>>(() => blank(properties));
  const [raw, setRaw] = useState(false);
  const [text, setText] = useState(() => JSON.stringify(blank(properties), null, 2));
  const [need, setNeed] = useState<string>();

  const set = (key: string, next: unknown) => {
    setNeed(undefined);
    setValue((held) => ({ ...held, [key]: next }));
  };

  const send = () => {
    if (raw) return onSend(JSON.parse(text));
    const empty = required.filter((key) => {
      const held = value[key];
      return held === undefined || held === "" || (Array.isArray(held) && held.length === 0);
    });
    if (empty.length > 0) {
      return setNeed(
        `Fill in ${empty.join(", ")} first — the flow needs ${empty.length === 1 ? "it" : "them"}.`,
      );
    }
    onSend(value);
  };

  return (
    <>
      {!raw &&
        Object.entries(properties).map(([key, field]) => (
          <label key={key} className={field.type === "boolean" ? "field tick" : "field"}>
            {field.type === "boolean" && (
              <input type="checkbox" checked={Boolean(value[key])} onChange={(e) => set(key, e.target.checked)} />
            )}
            <span>
              {key}
              {required.includes(key) && <em className="need"> · needed</em>}
            </span>
            {(field.type === "number" || field.type === "integer") && (
              <input
                type="number"
                value={value[key] === undefined ? "" : String(value[key])}
                onChange={(e) => set(key, e.target.value === "" ? undefined : Number(e.target.value))}
              />
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
      {need && <p className="bad small">{need}</p>}
      <div className="row" style={{ marginBottom: 0 }}>
        <button className="go" onClick={send}>
          {label}
        </button>
        <button
          className="quiet"
          onClick={() => {
            if (!raw) setText(JSON.stringify(value, null, 2));
            setRaw(!raw);
            setNeed(undefined);
          }}
        >
          {raw ? "Use the form" : "Write JSON"}
        </button>
      </div>
    </>
  );
}

/** The promise of a step, in the words that invariant 5 uses for it. */
function promise(changes: NonNullable<Step["changes"]>): string {
  if (changes === "nothing") return "changes nothing";
  if ("except" in changes) return `changes nothing in ${changes.except.join(", ")}`;
  return `changes only ${changes.paths.join(", ")}`;
}

function blank(properties: Record<string, Schema>): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(properties)) {
    if (field.type === "boolean") value[key] = false;
    // A number stays empty: a pre-filled 0 is an answer no one gave.
    else if (field.type === "number" || field.type === "integer") value[key] = undefined;
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
    if (event.type === "skip") marks[event.step as string] = "skipped";
  }
  for (const id of live) marks[id] = "running";
  if (state.waitingFor) marks[state.waitingFor] = "waiting";
  return marks;
}

/** The steps that started and have not ended, with the moment each one began. */
function liveSteps(events: RunEvent[]): Array<{ id: string; since: string }> {
  const live = new Map<string, string>();
  for (const event of events) {
    if (event.type === "step_start") live.set(String(event.step), event.at);
    if (event.type === "step_end" || event.type === "skip") live.delete(String(event.step));
  }
  return [...live].map(([id, since]) => ({ id, since }));
}

/** The step the page shows while no one has chosen: the one that acts now. */
function followed(state: RunState, live: Array<{ id: string }>): string | undefined {
  if (state.waitingFor) return state.waitingFor;
  const fault = broken(state);
  if (state.status === "failed" && fault) return fault[0];
  return live[live.length - 1]?.id;
}

/** The step whose failure the run carries, when one does. */
function broken(state: RunState): [string, StepRecord] | undefined {
  return Object.entries(state.steps).find(([, record]) => record.status === "failed");
}

/**
 * The value the run returns: the value of the step it ends with. More ends
 * than one mean the flow returns nothing, and the reader picks a step instead.
 */
function returned(state: RunState): unknown {
  const needed = new Set(state.flow.steps.flatMap((one) => one.needs));
  const ends = state.flow.steps.filter((one) => !needed.has(one.id));
  const end = ends.length === 1 ? ends[0] : undefined;
  const record = end && state.steps[end.id];
  return record?.status === "done" ? record.value : undefined;
}

function attempts(state: RunState, id: string): StepRecord[] {
  return (state.history ?? []).filter((one) => one.step === id).map((one) => one.record);
}

/** A ticker for a page that shows elapsed time, so the numbers move. */
function useTick(on: boolean) {
  const [, setCount] = useState(0);
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => setCount((count) => count + 1), 1000);
    return () => clearInterval(timer);
  }, [on]);
}

function say(event: RunEvent): string {
  switch (event.type) {
    case "run_start":
      return "the run started";
    case "step_start":
      return "started";
    case "step_end":
      return `ended ${String(event.status)}`;
    case "skip":
      return `skipped, because ${String(event.why)}`;
    case "cycle":
      return `goes back to ${String(event.to)} (round ${String(event.count)})`;
    case "waiting":
      return "waits for a person";
    case "run_end":
      return `the run is ${String(event.status)}`;
    default:
      return event.type;
  }
}
