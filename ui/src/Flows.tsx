import { type CSSProperties, useState } from "react";
import { api, useLoad } from "./api";
import { Loading } from "./Runs";

export function Flows() {
  const health = useLoad(() => api.health(), []);
  const { value: flows, again } = useLoad(() => api.flows(), []);
  const [path, setPath] = useState("");
  const [harness, setHarness] = useState("pi");
  const [fault, setFault] = useState<string>();
  const [note, setNote] = useState<string>();

  const add = () =>
    api
      .addFlow(path, harness)
      .then(() => (setPath(""), setFault(undefined), setNote(undefined), again()))
      .catch((problem: Error) => setFault(problem.message));

  const start = (id: number) =>
    api
      .startFlow(id)
      .then(() => (setFault(undefined), setNote("The run is in the queue.")))
      .catch((problem: Error) => (setNote(undefined), setFault(problem.message)));

  return (
    <section className="stagger">
      <h1>Flows</h1>
      <p className="note" style={{ "--i": 1 } as CSSProperties}>
        A step acts in <span className="mono">{health.value?.root ?? "…"}</span>, so a path is relative to it.
      </p>

      <div className="panel" style={{ "--i": 2 } as CSSProperties}>
        <h3>Register a flow file</h3>
        <div className="row" style={{ marginBottom: 0, flexWrap: "nowrap" }}>
          <input
            placeholder="examples/code-review/flow.yaml"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void add()}
          />
          <div className="segmented" style={{ flex: "none" }}>
            {(health.value?.adapters ?? ["pi"]).map((name) => (
              <button key={name} className={harness === name ? "on" : ""} onClick={() => setHarness(name)}>
                {name}
              </button>
            ))}
          </div>
          <button className="go" onClick={() => void add()}>
            Register
          </button>
        </div>
        {fault && <pre className="bad">{fault}</pre>}
        {note && <p className="good small">{note}</p>}
      </div>

      {!flows && <Loading />}

      {flows?.length === 0 && (
        <div className="panel">
          <h3>No flow yet</h3>
          <p className="note" style={{ margin: 0 }}>
            Give the path of a flow file above. Orchy reads it, draws it, and runs it.
          </p>
        </div>
      )}

      {flows && flows.length > 0 && (
        <div className="group" style={{ "--i": 3 } as CSSProperties}>
          {flows.map((flow, index) => (
            <div key={flow.id} className="flow-line" style={{ "--i": index + 4 } as CSSProperties}>
              <div className="grow">
                <div className="name">{flow.name}</div>
                <div className="dim small mono">{flow.path}</div>
              </div>
              <span className="pill">{flow.harness}</span>
              <button className="go" onClick={() => void start(flow.id)}>
                Run
              </button>
              <a className="button" href={`#/flows/${flow.id}`}>
                Edit
              </a>
              <button className="quiet" onClick={() => void api.removeFlow(flow.id).then(again)}>
                Forget
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
