import { type Atif, type Turn, api, useLoad } from "./api";
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
        {spend.total_steps === 1 ? "" : "s"} · {tokens(spend)} tokens
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
        {orchy?.dropped && <span className="note small">a cycle dropped this run</span>}
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
        {child?.steps.map((one, index) => (
          <Conversation key={index} turn={one} />
        ))}
        {!child && <p className="empty">{turn.message}</p>}
        {child && child.steps.length === 0 && <p className="empty">The harness wrote no turn.</p>}
      </div>
    </details>
  );
}

function Conversation({ turn }: { turn: Turn }) {
  return (
    <div className={`turn ${turn.source}`}>
      <span className="who">{turn.source}</span>
      <div className="said">
        {turn.reasoning_content && <p className="thought">{turn.reasoning_content}</p>}
        {turn.message.trim() && <p className="what">{turn.message}</p>}
        {turn.tool_calls?.map((call) => (
          <div key={call.tool_call_id} className="call">
            <code>{call.function_name}</code>
            <pre className="small">{JSON.stringify(call.arguments, null, 2)}</pre>
          </div>
        ))}
        {turn.observation?.results.map((result, index) => (
          <pre key={index} className="small result">
            {result.content}
          </pre>
        ))}
        {turn.metrics && tokens(turn.metrics) > 0 && (
          <span className="note small">{tokens(turn.metrics).toLocaleString()} tokens</span>
        )}
      </div>
    </div>
  );
}

function tokens(metrics: { prompt_tokens: number; completion_tokens: number }): number {
  return (metrics.prompt_tokens ?? 0) + (metrics.completion_tokens ?? 0);
}
