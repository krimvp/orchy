import { useState } from "react";
import { api, useLoad } from "./api";

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
      .then(() => (setPath(""), setFault(undefined), again()))
      .catch((problem: Error) => setFault(problem.message));

  const start = (id: number) =>
    api
      .startFlow(id)
      .then(() => (setFault(undefined), setNote("The run is in the queue.")))
      .catch((problem: Error) => (setNote(undefined), setFault(problem.message)));

  return (
    <section>
      <h1>Flows</h1>
      <p className="note">
        A step acts in <span className="mono">{health.value?.root ?? "…"}</span>, so a path is relative to it.
      </p>

      <div className="row">
        <input
          placeholder="examples/code-review/flow.yaml"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void add()}
        />
        <select value={harness} onChange={(e) => setHarness(e.target.value)}>
          {(health.value?.adapters ?? ["pi"]).map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
        <button className="go" onClick={() => void add()}>
          Register
        </button>
      </div>
      {fault && <pre className="bad">{fault}</pre>}
      {note && <p className="good">{note}</p>}

      {flows?.length === 0 && <p className="empty">No flow yet. Give the path of a flow file above.</p>}

      {flows && flows.length > 0 && (
        <table className="rows">
          <thead>
            <tr>
              <th>Name</th>
              <th>File</th>
              <th>Harness</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {flows.map((flow) => (
              <tr key={flow.id}>
                <td>{flow.name}</td>
                <td className="mono small">{flow.path}</td>
                <td>{flow.harness}</td>
                <td className="row">
                  <button className="go" onClick={() => void start(flow.id)}>
                    Run
                  </button>
                  <a className="button" href={`#/flows/${flow.id}`}>
                    Edit
                  </a>
                  <button onClick={() => void api.removeFlow(flow.id).then(again)}>Forget</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
