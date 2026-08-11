import { type ReactNode } from "react";
import { type Atif, type Metrics, type ToolCall, type Turn, api, useLoad } from "./api";
import { length, said } from "./Runs";

/**
 * The record of a run, as ATIF holds it. Each root step is one run of one step,
 * including a run that a cycle dropped, and each one opens on the turns that
 * the harness took.
 */
export function Trajectory({ runId, at }: { runId: string; at: number }) {
  const { value, error } = useLoad(() => api.trajectory(runId), [runId, at]);

  if (error) return <p className="empty">No trajectory yet. Orchy writes it wherever the run stops.</p>;
  if (!value) return <div className="skeleton" />;

  const spend = value.final_metrics;
  return (
    <div className="panel">
      <p className="note small" style={{ marginTop: 0 }}>
        {value.agent.name} · {value.schema_version} · model {value.agent.model_name} · {spend.total_steps} step
        {spend.total_steps === 1 ? "" : "s"} · {tokens(spend).toLocaleString()} tokens
        {spend.cost_usd ? ` · $${spend.cost_usd.toFixed(4)}` : ""}
      </p>

      {value.steps.map((turn, index) => (
        <Attempt key={`${turn.step_id}-${index}`} turn={turn} trajectory={value} />
      ))}
      {value.steps.length === 0 && <p className="empty">No step has ended yet.</p>}
    </div>
  );
}

function Attempt({ turn, trajectory }: { turn: Turn; trajectory: Atif }) {
  const orchy = turn.extra?.orchy;
  const child = trajectory.subagent_trajectories?.find(
    (one) => one.trajectory_id === turn.subagent_trajectory_ref?.trajectory_id,
  );
  // A step that ends in the same millisecond it started took no time, not no value.
  const took = orchy ? new Date(orchy.endedAt).getTime() - new Date(orchy.startedAt).getTime() : undefined;

  return (
    <details className={`attempt ${orchy?.dropped ? "dropped" : ""}`}>
      <summary>
        <span className={`pill ${orchy?.status ?? ""}`}>{orchy?.status ?? turn.source}</span>
        <b>{orchy?.step ?? `step ${turn.step_id}`}</b>
        {orchy?.dropped && <span className="note small">a loop dropped this attempt</span>}
        {turn.source === "user" && <span className="note small">a person answered</span>}
        {orchy?.disagreement && <span className="note small">disagreement accepted</span>}
        <span className="spend">
          {took === undefined ? "" : length(took)}
          {turn.metrics && tokens(turn.metrics) > 0 ? ` · ${tokens(turn.metrics).toLocaleString()} tokens` : ""}
          {turn.metrics?.cost_usd ? ` · $${turn.metrics.cost_usd.toFixed(4)}` : ""}
        </span>
      </summary>

      <div className="turns">
        {orchy?.changed && (
          <p className="note small">
            Changed <span className="mono">{said(orchy.changed)}</span>
          </p>
        )}
        {child?.steps.filter(speaks).map((one, index) => (
          <Conversation key={index} turn={one} />
        ))}
        {child && child.steps.length === 0 && <p className="empty">The harness wrote no turn.</p>}
        {/* The value of the step closes its record, so a reader ends on the answer. */}
        {turn.message.trim() && (
          <div className="answer">
            <span className="who">{child ? "answer" : ""}</span>
            <Prose text={turn.message} />
          </div>
        )}
      </div>
    </details>
  );
}

function Conversation({ turn }: { turn: Turn }) {
  return (
    <div className={`turn ${turn.source}`}>
      <span className="who">{turn.source}</span>
      <div className="said">
        {turn.reasoning_content && (
          <details className="thinking">
            <summary>thought {excerpt(turn.reasoning_content)}</summary>
            <p className="thought">{turn.reasoning_content}</p>
          </details>
        )}
        {turn.message.trim() && <Prose text={turn.message} />}
        {turn.tool_calls?.map((call) => (
          <Call key={call.tool_call_id} call={call} result={resultOf(turn, call)} />
        ))}
        {orphans(turn).map((result, index) => (
          <Result key={index} content={result} />
        ))}
        {turn.metrics && tokens(turn.metrics) > 0 && (
          <span className="note small">{tokens(turn.metrics).toLocaleString()} tokens</span>
        )}
      </div>
    </div>
  );
}

/**
 * One tool call, told as what it did: the name, the argument that matters, and
 * the rest behind a fold. The result of the call sits with it, so a reader
 * never pairs ids by hand.
 */
function Call({ call, result }: { call: ToolCall; result?: string }) {
  const gist = gistOf(call);
  const rest = Object.keys(call.arguments).length > 0;
  return (
    <div className="call">
      <div className="did">
        <code>{call.function_name}</code>
        {gist && <span className="gist mono">{gist}</span>}
      </div>
      {rest && (
        <details>
          <summary>the arguments</summary>
          <pre className="small">{JSON.stringify(call.arguments, null, 2)}</pre>
        </details>
      )}
      {result !== undefined && <Result content={result} />}
    </div>
  );
}

/** A result folds shut, and its first line says what a reader would open it for. */
function Result({ content }: { content: string }) {
  const line = content.trim().split("\n")[0] ?? "";
  return (
    <details className="result-fold">
      <summary>
        <span className="mono">{excerpt(line, 88)}</span>
        <span className="note small"> · {content.length.toLocaleString()} chars</span>
      </summary>
      <pre className="small result">{content}</pre>
    </details>
  );
}

/**
 * Plain text with the shapes a model writes: paragraphs, fenced code, and
 * `code` in a line. Nothing more, because a renderer that guesses draws wrong.
 */
export function Prose({ text }: { text: string }) {
  const parts = text.split(/```[^\n]*\n?/);
  return (
    <div className="prose">
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <pre key={index} className="small">
            {part.replace(/\n$/, "")}
          </pre>
        ) : (
          part
            .split(/\n{2,}/)
            .filter((one) => one.trim())
            .map((paragraph, at) => <p key={`${index}-${at}`}>{inline(paragraph)}</p>)
        ),
      )}
    </div>
  );
}

/** `code` inside a line. The rest of the line stays as the model wrote it. */
function inline(text: string): ReactNode[] {
  return text.split(/(`[^`\n]+`)/).map((part, index) =>
    part.startsWith("`") && part.endsWith("`") ? <code key={index}>{part.slice(1, -1)}</code> : part,
  );
}

/** The one argument a reader wants in the summary line of a call. */
function gistOf(call: ToolCall): string | undefined {
  const args = call.arguments;
  const first = ["path", "file_path", "command", "pattern", "query", "url", "cmd", "file"]
    .map((key) => args[key])
    .find((one) => typeof one === "string");
  const held = first ?? Object.values(args).find((one) => typeof one === "string");
  return typeof held === "string" ? excerpt(held, 80) : undefined;
}

/** The result that answers this call, so the pair reads as one exchange. */
function resultOf(turn: Turn, call: ToolCall): string | undefined {
  return turn.observation?.results.find((one) => one.source_call_id === call.tool_call_id)?.content;
}

/** A turn with nothing to show is a row of noise, so it does not stand. */
function speaks(turn: Turn): boolean {
  return Boolean(
    turn.reasoning_content ||
      turn.message.trim() ||
      (turn.tool_calls?.length ?? 0) > 0 ||
      (turn.observation?.results.length ?? 0) > 0,
  );
}

/** A result whose call is elsewhere still shows, or the record hides a cost. */
function orphans(turn: Turn): string[] {
  const called = new Set((turn.tool_calls ?? []).map((one) => one.tool_call_id));
  return (turn.observation?.results ?? []).filter((one) => !called.has(one.source_call_id)).map((one) => one.content);
}

function excerpt(text: string, limit = 64): string {
  const line = text.trim().replace(/\s+/g, " ");
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

function tokens(metrics: Metrics): number {
  return (metrics.prompt_tokens ?? 0) + (metrics.completion_tokens ?? 0);
}
