import { useEffect, useState } from "react";
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

  return (
    <>
      <nav>
        <strong>Orchy</strong>
        <a href="#/" className={parts[0] === "" || parts[0] === "runs" ? "here" : ""}>
          Runs
        </a>
        <a href="#/flows" className={parts[0] === "flows" ? "here" : ""}>
          Flows
        </a>
      </nav>
      <main>
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
