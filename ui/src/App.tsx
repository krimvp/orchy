import { useEffect, useRef, useState } from "react";
import { api, unsaved, useLoad, useNotices } from "./api";
import { Editor } from "./Editor";
import { Flows } from "./Flows";
import { Run } from "./Run";
import { Runs } from "./Runs";

function useHash(): string {
  const [hash, setHash] = useState(location.hash || "#/");
  const held = useRef(location.hash || "#/");
  useEffect(() => {
    const read = () => {
      const next = location.hash || "#/";
      // The step back after a refused leave lands here; it is not a move.
      if (next === held.current) return;
      // An editor with unsaved changes asks before the page leaves it behind.
      if (unsaved.here && !confirm("This flow holds changes that are not saved. Leave and lose them?")) {
        location.hash = held.current;
        return;
      }
      held.current = next;
      setHash(next);
    };
    addEventListener("hashchange", read);
    return () => removeEventListener("hashchange", read);
  }, []);
  return hash;
}

/** One dot, drawn in the color of what the runs need. The tab says it too. */
function favicon(color: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="${color}"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * The tab and, when a person allows it, the system say whose move it is. A run
 * that waits at a gate waits silently otherwise, and this is the whole fix.
 */
function useAttention() {
  const { events } = useNotices();
  const runs = useLoad(() => api.runs(), []);
  const [allowed, setAllowed] = useState(
    () => typeof Notification !== "undefined" && Notification.permission === "granted",
  );

  useEffect(() => {
    runs.again();
  }, [events.length, runs.again]);

  const waiting = runs.value?.filter((run) => run.status === "waiting") ?? [];
  const running = runs.value?.filter((run) => run.status === "running") ?? [];

  // The tab title and its dot carry the state to a person who looks away.
  useEffect(() => {
    document.title =
      waiting.length > 0
        ? `(${waiting.length}) Your turn — Orchy`
        : running.length > 0
          ? `Orchy — ${running.length} running`
          : "Orchy";
    let link = document.querySelector<HTMLLinkElement>("link[rel=icon]");
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.href = favicon(waiting.length > 0 ? "#e0a542" : running.length > 0 ? "#4c8f5f" : "#8a8a8a");
  }, [waiting.length, running.length]);

  // One notice for each run that starts to wait or ends, sent as it happens.
  useEffect(() => {
    if (!allowed || typeof Notification === "undefined") return;
    const last = events[events.length - 1];
    if (!last || !document.hidden) return;
    if (last.type === "waiting") {
      new Notification("Your turn — a run waits for you", { body: String(last.question ?? "") });
    }
    if (last.type === "run_end") {
      new Notification(`A run is ${String(last.status)}`, { body: "Open Orchy to read what it returned." });
    }
  }, [events, allowed]);

  const ask = () =>
    void Notification.requestPermission().then((answer) => setAllowed(answer === "granted"));

  return { waiting: waiting.length, allowed, ask };
}

export function App() {
  const hash = useHash();
  const parts = hash.replace(/^#\/?/, "").split("/");
  const health = useLoad(() => api.health(), []);
  const attention = useAttention();
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
            {attention.waiting > 0 && <span className="dot waiting" title="A run waits for you" />}
          </a>
          <a href="#/flows" className={parts[0] === "flows" ? "here" : ""}>
            Flows
          </a>
        </div>
        {!attention.allowed && typeof Notification !== "undefined" && (
          <button
            className="quiet small"
            title="Get a system notification when a run waits for you or ends."
            onClick={attention.ask}
          >
            Notify me
          </button>
        )}
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
