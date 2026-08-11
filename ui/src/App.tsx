import { useEffect, useState } from "react";
import { api, useLoad } from "./api";
import { Editor } from "./Editor";
import { Flows } from "./Flows";
import { Run } from "./Run";
import { Runs } from "./Runs";

function useHash(): string {
  const [hash, setHash] = useState(location.hash || "#/");
  useEffect(() => {
    const read = () => setHash(location.hash || "#/");
    addEventListener("hashchange", read);
    return () => removeEventListener("hashchange", read);
  }, []);
  return hash;
}

export function App() {
  const hash = useHash();
  const parts = hash.replace(/^#\/?/, "").split("/");
  const health = useLoad(() => api.health(), []);
  const onRuns = parts[0] === "" || parts[0] === "runs";

  return (
    <>
      <nav>
        <a className="brand" href="#/">
          Orchy
        </a>
        <div className="tabs">
          <a href="#/" className={onRuns ? "here" : ""}>
            Runs
          </a>
          <a href="#/flows" className={parts[0] === "flows" ? "here" : ""}>
            Flows
          </a>
        </div>
        <span className="root mono" title={health.value?.root}>
          {health.value?.root}
        </span>
      </nav>
      {/* A new key for a new view, so the page arrives instead of blinking. */}
      <main key={parts.join("/")}>
        {parts[0] === "runs" && parts[1] ? (
          <Run runId={parts[1]} />
        ) : parts[0] === "flows" && parts[1] ? (
          <Editor id={Number(parts[1])} />
        ) : parts[0] === "flows" ? (
          <Flows />
        ) : (
          <Runs />
        )}
      </main>
    </>
  );
}
