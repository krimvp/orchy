import type { Step } from "./api";

export type Mark = "done" | "failed" | "running" | "waiting" | "idle";

const W = 168;
const H = 46;
const GAP_X = 64;
const GAP_Y = 18;
const PAD = 12;

interface Placed {
  step: Step;
  x: number;
  y: number;
}

/**
 * A step sits one column to the right of every step it needs, so the drawing
 * says the same thing as invariant 3.
 */
function place(steps: Step[]): Placed[] {
  const depth = new Map<string, number>();
  const of = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    const step = steps.find((one) => one.id === id);
    // A guard for a flow that a person is still editing, which may hold a loop.
    depth.set(id, 0);
    const value = !step || step.needs.length === 0 ? 0 : 1 + Math.max(...step.needs.map(of));
    depth.set(id, value);
    return value;
  };

  const rows = new Map<number, number>();
  return steps.map((step) => {
    const column = of(step.id);
    const row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    return { step, x: PAD + column * (W + GAP_X), y: PAD + row * (H + GAP_Y) };
  });
}

export function Graph({
  steps,
  marks = {},
  selected,
  onSelect,
}: {
  steps: Step[];
  marks?: Record<string, Mark>;
  selected?: string;
  onSelect?: (id: string) => void;
}) {
  if (steps.length === 0) return <p className="empty">This flow has no steps yet.</p>;

  const nodes = place(steps);
  const at = new Map(nodes.map((node) => [node.step.id, node]));
  const width = Math.max(...nodes.map((node) => node.x + W)) + PAD;
  const height = Math.max(...nodes.map((node) => node.y + H)) + PAD + 34;

  const needs = nodes.flatMap((node) =>
    node.step.needs.map((need) => {
      const from = at.get(need);
      if (!from) return null;
      const x1 = from.x + W;
      const y1 = from.y + H / 2;
      const x2 = node.x;
      const y2 = node.y + H / 2;
      return (
        <path
          key={`${need}->${node.step.id}`}
          className="edge"
          d={`M ${x1} ${y1} C ${x1 + GAP_X / 2} ${y1}, ${x2 - GAP_X / 2} ${y2}, ${x2} ${y2}`}
          markerEnd="url(#tip)"
        />
      );
    }),
  );

  const cycles = nodes.flatMap((node) => {
    const cycle = node.step.cycle;
    const back = cycle && at.get(cycle.to);
    if (!cycle || !back) return [];
    const y = Math.max(node.y, back.y) + H + 20;
    return [
      <g key={`cycle-${node.step.id}`}>
        <path
          className="edge cycle"
          d={`M ${node.x + W / 2} ${node.y + H} C ${node.x + W / 2} ${y}, ${back.x + W / 2} ${y}, ${back.x + W / 2} ${back.y + H}`}
          markerEnd="url(#tip)"
        />
        <text className="limit" x={(node.x + back.x + W) / 2} y={y - 2}>
          {cycle.limit}×
        </text>
      </g>,
    ];
  });

  return (
    <svg className="graph" viewBox={`0 0 ${width} ${height}`} style={{ maxWidth: width }}>
      <defs>
        <marker id="tip" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M 0 0 L 8 4 L 0 8 z" className="tip" />
        </marker>
      </defs>
      {cycles}
      {needs}
      {nodes.map((node) => (
        <g
          key={node.step.id}
          className={`node ${marks[node.step.id] ?? "idle"} ${selected === node.step.id ? "chosen" : ""}`}
          transform={`translate(${node.x} ${node.y})`}
          onClick={() => onSelect?.(node.step.id)}
        >
          {/* A fanout is one step in the file and many in the run, so it stands as a stack. */}
          {node.step.fanout && node.step.fanout.length > 1 && (
            <rect className="box behind" x="5" y="-5" width={W} height={H} rx="7" />
          )}
          <rect className="box" width={W} height={H} rx="7" />
          <title>{node.step.id}</title>
          <text className="name" x="11" y="20">
            {short(node.step.id)}
          </text>
          <text className="kind" x="11" y="36">
            {label(node.step)}
          </text>
        </g>
      ))}
    </svg>
  );
}

function short(text: string, limit = 22): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** A run resolves a path against the flow file, so only the end of it says anything. */
function file(path: string): string {
  return short(path.split("/").pop() ?? path, 24);
}

function label(step: Step): string {
  const many = step.fanout?.length ? ` ×${step.fanout.length}` : "";
  if (step.kind === "agent") {
    return `${short([step.harness ?? "the default", step.model].filter(Boolean).join(" · "), 24)}${many}`;
  }
  if (step.kind === "call") return `${file(step.module ?? "call")}${many}`;
  if (step.kind === "gate") return "a person answers";
  return file(step.flow ?? "flow");
}
