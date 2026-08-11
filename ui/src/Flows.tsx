import { type CSSProperties, useState } from "react";
import { type FlowRow, type Schema, api, follow, useLoad } from "./api";
import { Contract } from "./Run";
import { Loading, length, when } from "./Runs";

/**
 * Brings a panel into view when it mounts. The button that opens one can sit
 * far down the list, and a panel no one sees is a click that did nothing.
 */
function reveal(panel: HTMLDivElement | null): void {
  panel?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

export function Flows() {
  const health = useLoad(() => api.health(), []);
  const { value: flows, again } = useLoad(() => api.flows(), []);
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [making, setMaking] = useState(false);
  const [harness, setHarness] = useState("pi");
  const [fault, setFault] = useState<string>();
  const [note, setNote] = useState<string>();
  const [asking, setAsking] = useState<{ id: number; name: string; takes: Schema }>();
  /** The flow whose schedule stands open below the list head. */
  const [timing, setTiming] = useState<{ id: number; name: string; takes?: Schema }>();
  /** The flow whose run is on its way to the run page, so its button rests. */
  const [busy, setBusy] = useState<number>();

  const add = () =>
    api
      .addFlow(path, harness)
      .then(() => (setPath(""), setFault(undefined), setNote(undefined), again()))
      .catch((problem: Error) => setFault(problem.message));

  /** Scaffolds a flow — from a name, or at the path a register just missed. */
  const create = (wanted: { name?: string; path?: string }) =>
    api
      .newFlow(wanted.name ?? "", harness, wanted.path)
      .then((row) => {
        location.hash = `#/flows/${row.id}`;
      })
      .catch((problem: Error) => setFault(problem.message));

  const begin = (id: number, values?: Record<string, unknown>) => {
    setBusy(id);
    setAsking(undefined);
    setFault(undefined);
    setNote("Starting the run…");
    return api
      .startFlow(id, values)
      .then((ticket) => follow(ticket))
      .catch((problem: Error) => (setNote(undefined), setFault(problem.message)))
      .finally(() => setBusy(undefined));
  };

  // The flow says what it takes, so the page asks for those values and no others.
  const start = (id: number) =>
    api
      .flow(id)
      .then((one) =>
        one.flow.takes ? setAsking({ id, name: one.flow.name, takes: one.flow.takes }) : void begin(id),
      )
      .catch((problem: Error) => (setNote(undefined), setFault(problem.message)));

  const time = (id: number) =>
    api
      .flow(id)
      .then((one) => {
        setAsking(undefined);
        setTiming({ id, name: one.flow.name, takes: one.flow.takes });
      })
      .catch((problem: Error) => setFault(problem.message));

  // The register just said the file is not there, so creating it is one click.
  const offerToCreate = fault?.includes("there is no file at") && path.trim() !== "";

  return (
    <section className="stagger">
      <h1>Flows</h1>
      <p className="note" style={{ "--i": 1 } as CSSProperties}>
        A step acts in <span className="mono">{health.value?.root ?? "…"}</span>, so a path is relative to it.
      </p>

      <div className="panel" style={{ "--i": 2 } as CSSProperties}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3 style={{ margin: 0 }}>{making ? "New flow" : "Add a flow"}</h3>
          <button className={making ? "quiet" : "go"} onClick={() => (setMaking(!making), setFault(undefined))}>
            {making ? "Register a file instead" : "New flow"}
          </button>
        </div>
        {making ? (
          <>
            <p className="note small">
              Orchy writes <span className="mono">flows/&lt;name&gt;/flow.yaml</span> with one step and its
              prompt, and opens it in the editor.
            </p>
            <div className="row" style={{ marginBottom: 0, flexWrap: "nowrap" }}>
              <input
                placeholder="what should it be called?"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && name.trim() && void create({ name })}
              />
              <HarnessPick health={health.value} harness={harness} onPick={setHarness} />
              <button className="go" disabled={!name.trim()} onClick={() => void create({ name })}>
                Create it
              </button>
            </div>
          </>
        ) : (
          <div className="row" style={{ marginBottom: 0, flexWrap: "nowrap" }}>
            <input
              placeholder="examples/code-review/flow.yaml"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void add()}
            />
            <HarnessPick health={health.value} harness={harness} onPick={setHarness} />
            <button className="go" onClick={() => void add()}>
              Register
            </button>
          </div>
        )}
        {fault && <pre className="bad">{fault}</pre>}
        {offerToCreate && (
          <div className="row" style={{ marginBottom: 0 }}>
            <button className="go" onClick={() => void create({ path })}>
              Create a new flow at {path}
            </button>
          </div>
        )}
        {note && <p className="good small">{note}</p>}
      </div>

      {asking && (
        <div className="panel gate" ref={reveal}>
          <h2>The flow {asking.name} takes values</h2>
          <Contract
            key={asking.id}
            schema={asking.takes}
            label="Start the run"
            onSend={(values) => void begin(asking.id, values as Record<string, unknown>)}
          />
        </div>
      )}

      {timing && (
        <Timing
          flow={flows?.find((one) => one.id === timing.id)}
          name={timing.name}
          takes={timing.takes}
          onDone={() => {
            setTiming(undefined);
            again();
          }}
          onChanged={again}
          onFault={setFault}
        />
      )}

      {!flows && <Loading />}

      {flows?.length === 0 && (
        <div className="panel">
          <h3>No flow yet</h3>
          <p className="note" style={{ margin: 0 }}>
            Create a new flow above, or give the path of a flow file you already have.
          </p>
        </div>
      )}

      {flows && flows.length > 0 && (
        <div className="group" style={{ "--i": 3 } as CSSProperties}>
          {flows.map((flow, index) => (
            <div key={flow.id} className="flow-line" style={{ "--i": index + 4 } as CSSProperties}>
              <div className="grow">
                <a className="name" href={`#/flows/${flow.id}`}>
                  {flow.name}
                </a>
                {flow.description && <div className="dim small">{flow.description}</div>}
                <div className="dim small mono">{flow.path}</div>
              </div>
              <LastRun flow={flow} />
              {flow.schedule && (
                <span className="dim small" title="This flow runs by itself.">
                  every {every(flow.schedule.everyMinutes)}
                </span>
              )}
              <span className="pill">{flow.harness}</span>
              <button className="go" disabled={busy === flow.id} onClick={() => void start(flow.id)}>
                {busy === flow.id ? "Starting…" : "Run"}
              </button>
              <button
                className="quiet"
                title="Run this flow by itself, on an interval."
                onClick={() => void time(flow.id)}
              >
                {flow.schedule ? "Reschedule" : "Schedule"}
              </button>
              <a
                className="button"
                href={`#/flows/${flow.id}/runs`}
                title="Every run of this flow, and the next one"
              >
                Runs
              </a>
              <a className="button" href={`#/flows/${flow.id}`}>
                Edit
              </a>
              <button
                className="quiet"
                title="Removes the flow from this list. The file stays where it is."
                onClick={() => void api.removeFlow(flow.id).then(again)}
              >
                Forget
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function HarnessPick({
  health,
  harness,
  onPick,
}: {
  health?: { adapters: string[] };
  harness: string;
  onPick: (name: string) => void;
}) {
  return (
    <div
      className="segmented"
      style={{ flex: "none" }}
      title="The harness is the agent program that runs each step."
    >
      {(health?.adapters ?? ["pi"]).map((name) => (
        <button key={name} className={harness === name ? "on" : ""} onClick={() => onPick(name)}>
          {name}
        </button>
      ))}
    </div>
  );
}

/** `45 min`, `6 h`, `2 d` — the interval of a schedule, in the closest plain unit. */
function every(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} h`;
  return `${Math.round(minutes / 1440)} d`;
}

const UNITS = [
  { name: "hours", minutes: 60 },
  { name: "days", minutes: 1440 },
] as const;

/**
 * The schedule of one flow: how often it runs by itself, and the values each
 * run takes. The first run starts within a minute, which is also the proof
 * that the schedule works.
 */
function Timing({
  flow,
  name,
  takes,
  onDone,
  onChanged,
  onFault,
}: {
  flow?: FlowRow;
  name: string;
  takes?: Schema;
  onDone: () => void;
  /** The list holds new facts, and the panel stays open to show them. */
  onChanged: () => void;
  onFault: (fault: string) => void;
}) {
  const [count, setCount] = useState(() => {
    const held = flow?.schedule?.everyMinutes;
    return held ? (held < 1440 ? Math.max(1, Math.round(held / 60)) : Math.round(held / 1440)) : 1;
  });
  const [unit, setUnit] = useState<(typeof UNITS)[number]["name"]>(
    (flow?.schedule?.everyMinutes ?? 1440) < 1440 ? "hours" : "days",
  );

  const save = (values?: Record<string, unknown>) => {
    const minutes = count * (UNITS.find((one) => one.name === unit)?.minutes ?? 1440);
    return api
      .setSchedule(flow?.id ?? 0, minutes, values)
      .then(onDone)
      .catch((problem: Error) => onFault(problem.message));
  };

  return (
    <div className="panel gate" ref={reveal}>
      <h2>Run {name} by itself</h2>
      <div className="row">
        <span className="dim">Every</span>
        <input
          type="number"
          min={1}
          style={{ width: 80 }}
          value={count}
          onChange={(e) => setCount(Math.max(1, Number(e.target.value)))}
        />
        <div className="segmented" style={{ flex: "none" }}>
          {UNITS.map((one) => (
            <button key={one.name} className={unit === one.name ? "on" : ""} onClick={() => setUnit(one.name)}>
              {one.name}
            </button>
          ))}
        </div>
      </div>
      <p className="note small">The first run starts within a minute, and each next one when the time has passed.</p>
      {takes ? (
        <Contract schema={takes} label="Schedule it" onSend={(values) => void save(values as Record<string, unknown>)} />
      ) : (
        <div className="row" style={{ marginBottom: 0 }}>
          <button className="go" onClick={() => void save()}>
            Schedule it
          </button>
        </div>
      )}
      {flow && <Hook flow={flow} onChanged={onChanged} onFault={onFault} />}
      <div className="row" style={{ marginBottom: 0, marginTop: 10 }}>
        {flow?.schedule && (
          <button
            className="danger"
            onClick={() => void api.clearSchedule(flow.id).then(onDone)}
          >
            Stop scheduling it
          </button>
        )}
        <button className="quiet" onClick={onDone}>
          Close
        </button>
      </div>
    </div>
  );
}

/**
 * The webhook of one flow. The token is the whole door: a POST to its URL
 * starts the run, with the body as the values the flow takes.
 */
function Hook({
  flow,
  onChanged,
  onFault,
}: {
  flow: FlowRow;
  onChanged: () => void;
  onFault: (fault: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const url = flow.hook ? `${location.origin}/api/hooks/${flow.hook}` : undefined;
  const copy = () =>
    void navigator.clipboard?.writeText(url ?? "").then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });

  return (
    <div className="field set" style={{ marginTop: 16 }}>
      <span>Or start it from a webhook</span>
      {url ? (
        <>
          <div className="row" style={{ margin: "10px 0 0", flexWrap: "nowrap" }}>
            <span className="mono small hookurl">{url}</span>
            <button className="quiet" onClick={copy}>
              {copied ? "Copied" : "Copy"}
            </button>
            <button className="quiet" onClick={() => void api.clearHook(flow.id).then(onChanged)}>
              Remove it
            </button>
          </div>
          <span className="note small">
            A POST to this URL starts the run. Send the values the flow takes as one JSON object. The token is
            the key, so share the URL with care.
          </span>
        </>
      ) : (
        <div className="row" style={{ margin: "10px 0 0" }}>
          <button
            className="quiet"
            onClick={() =>
              void api
                .setHook(flow.id)
                .then(onChanged)
                .catch((problem: Error) => onFault(problem.message))
            }
          >
            Make a webhook
          </button>
        </div>
      )}
    </div>
  );
}

/** What the last run of this flow came to, so a person knows before starting one. */
function LastRun({ flow }: { flow: FlowRow }) {
  const run = flow.lastRun;
  if (!run) return <span className="dim small">never ran</span>;
  const took = run.endedAt ? length(new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime()) : undefined;
  return (
    <a className="dim small lastrun" href={`#/runs/${run.runId}`} title="Open the last run">
      last run {when(run.startedAt)} · {run.status}
      {took ? ` · ${took}` : ""}
      {run.cost ? ` · $${run.cost.toFixed(2)}` : ""}
    </a>
  );
}
