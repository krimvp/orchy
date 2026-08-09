import type { CSSProperties } from "react";
import type { Cycle, Step } from "./api";

export type Mark = "done" | "failed" | "running" | "waiting" | "idle";

const W = 184;
const H = 58;
const GAP_X = 72;
const GAP_Y = 26;
const PAD = 14;
/** The distance between two lanes that carry an edge past the steps. */
const LANE = 24;
const CORNER = 9;

interface Placed {
  step: Step;
  column: number;
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
    return { step, column, x: PAD + column * (W + GAP_X), y: PAD + row * (H + GAP_Y) };
  });
}

/**
 * A path of straight lines, with a round corner at each turn. Every segment is
 * flat or upright, so the drawing reads as a diagram and not as a sketch.
 */
function orthogonal(points: Array<[number, number]>): string {
  const kept = points.filter(
    (point, index) => index === 0 || point[0] !== points[index - 1]?.[0] || point[1] !== points[index - 1]?.[1],
  );
  const first = kept[0];
  if (!first) return "";

  let d = `M ${first[0]} ${first[1]}`;
  for (let index = 1; index < kept.length - 1; index += 1) {
    const [ax, ay] = kept[index - 1] as [number, number];
    const [bx, by] = kept[index] as [number, number];
    const [cx, cy] = kept[index + 1] as [number, number];
    const back = Math.hypot(bx - ax, by - ay);
    const on = Math.hypot(cx - bx, cy - by);
    const radius = Math.min(CORNER, back / 2, on / 2);
    d += ` L ${bx + ((ax - bx) * radius) / back} ${by + ((ay - by) * radius) / back}`;
    d += ` Q ${bx} ${by} ${bx + ((cx - bx) * radius) / on} ${by + ((cy - by) * radius) / on}`;
  }
  const last = kept[kept.length - 1] as [number, number];
  return `${d} L ${last[0]} ${last[1]}`;
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

  const base = place(steps);
  const at = new Map(base.map((node) => [node.step.id, node]));

  const forward = base.flatMap((to) =>
    to.step.needs.flatMap((need) => {
      const from = at.get(need);
      return from ? [{ key: `${need}->${to.step.id}`, from, to, far: to.column > from.column + 1 }] : [];
    }),
  );

  const back = base.flatMap((from) => {
    const cycle = from.step.cycle;
    const to = cycle && at.get(cycle.to);
    return cycle && to ? [{ key: `cycle-${from.step.id}`, from, to, cycle }] : [];
  });

  // An edge that jumps a column passes above the steps, and a cycle passes
  // below them. The widest one takes the outer lane, so no two lanes cross.
  const jumps = forward.filter((edge) => edge.far).sort((a, b) => span(b) - span(a));
  const above = new Map(jumps.map((edge, index) => [edge.key, 10 + index * LANE]));
  const roomAbove = jumps.length > 0 ? jumps.length * LANE + 10 : 0;
  const loops = [...back].sort((a, b) => span(b) - span(a));

  /**
   * A cycle leaves the foot of a step and returns to the foot of another. That
   * upright run crosses every step below it in the same column, so a step with
   * a step below it takes the gap beside it instead, where nothing stands.
   */
  const feet = new Map<number, number>();
  for (const node of base) feet.set(node.column, Math.max(feet.get(node.column) ?? 0, node.y));
  const clear = (node: Placed) => feet.get(node.column) === node.y;
  const roomLeft = loops.some((edge) => !clear(edge.to) && edge.to.column === 0) ? GAP_X : 0;

  const nodes = base.map((node) => ({ ...node, x: node.x + roomLeft, y: node.y + roomAbove }));
  const put = new Map(nodes.map((node) => [node.step.id, node]));
  const floor = Math.max(...nodes.map((node) => node.y + H));
  const below = new Map(loops.map((edge, index) => [edge.key, floor + 22 + index * LANE]));
  const roomBelow = loops.length > 0 ? loops.length * LANE + 22 : 0;

  /**
   * Every edge that arrives at a step gets its own place on the left side of
   * it, in the order the edges approach. So two lines never end on one point,
   * and no two of them cross as they arrive.
   */
  const coming = [
    // An edge from a lane above arrives at the top, and a cycle from the lane
    // below arrives at the foot.
    ...forward.map((edge) => ({
      key: edge.key,
      to: edge.to.step.id,
      at: edge.far ? -1000 + (above.get(edge.key) ?? 0) : edge.from.y,
    })),
    ...loops
      .filter((edge) => !clear(edge.to))
      .map((edge) => ({ key: edge.key, to: edge.to.step.id, at: 100_000 })),
  ];
  const arrivals = new Map<string, string[]>();
  for (const node of nodes) {
    arrivals.set(
      node.step.id,
      coming
        .filter((one) => one.to === node.step.id)
        .sort((a, b) => a.at - b.at)
        .map((one) => one.key),
    );
  }
  const port = (node: Placed, key: string): number => {
    const held = arrivals.get(node.step.id) ?? [];
    const place = held.indexOf(key);
    if (place === -1) return node.y + H / 2;
    return node.y + (H * (place + 1)) / (held.length + 1);
  };

  /**
   * Every upright run of an edge sits in the gap between two columns, and the
   * edges that share one gap share it evenly. So two edges never cover one line.
   */
  const gaps = new Map<number, string[]>();
  const claim = (gap: number, key: string) => {
    const held = gaps.get(gap) ?? [];
    if (!held.includes(key)) held.push(key);
    gaps.set(gap, held);
  };
  for (const edge of forward) {
    const to = put.get(edge.to.step.id) as Placed;
    const from = put.get(edge.from.step.id) as Placed;
    if (edge.far) {
      claim(edge.from.column, edge.key);
      claim(edge.to.column - 1, edge.key);
    } else if (from.y + H / 2 !== port(to, edge.key)) {
      // A step that leaves and arrives at one height needs no turn at all.
      claim(edge.from.column, edge.key);
    }
  }
  for (const edge of loops) {
    if (!clear(edge.from)) claim(edge.from.column, edge.key);
    if (!clear(edge.to)) claim(edge.to.column - 1, edge.key);
  }
  const channel = (gap: number, key: string): number => {
    const held = gaps.get(gap) ?? [];
    // The runs keep away from both edges of the gap, so an arrow always has a
    // straight length to point along before it meets a step.
    const share = 0.24 + 0.52 * ((held.indexOf(key) + 1) / (held.length + 1));
    // A gap before the first column exists only when a cycle returns into it.
    const start = gap < 0 ? PAD : PAD + roomLeft + gap * (W + GAP_X) + W;
    return start + GAP_X * share;
  };

  const width = Math.max(...nodes.map((node) => node.x + W)) + PAD;
  const height = floor + roomBelow + PAD;

  const wire = (edge: (typeof forward)[number]): string => {
    const from = put.get(edge.from.step.id) as Placed;
    const to = put.get(edge.to.step.id) as Placed;
    const start: [number, number] = [from.x + W, from.y + H / 2];
    const end: [number, number] = [to.x, port(to, edge.key)];

    if (edge.far) {
      const lane = above.get(edge.key) as number;
      const out = channel(from.column, edge.key);
      const into = channel(to.column - 1, edge.key);
      return orthogonal([start, [out, start[1]], [out, lane], [into, lane], [into, end[1]], end]);
    }
    if (start[1] === end[1]) return orthogonal([start, end]);
    const turn = channel(from.column, edge.key);
    return orthogonal([start, [turn, start[1]], [turn, end[1]], end]);
  };

  return (
    <svg className="graph" viewBox={`0 0 ${width} ${height}`} width={width} height={height}>
      <defs>
        <marker id="tip" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M 0 0 L 8 4 L 0 8 z" className="tip" />
        </marker>
        {/* A marker takes no colour from the line it ends, so a cycle needs its own. */}
        <marker id="tip-cycle" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M 0 0 L 8 4 L 0 8 z" className="tip cycle" />
        </marker>
      </defs>

      {loops.map((edge) => {
        const from = put.get(edge.from.step.id) as Placed;
        const to = put.get(edge.to.step.id) as Placed;
        const lane = below.get(edge.key) as number;

        // The foot of a step, when nothing stands below it. The gap beside it
        // when something does.
        const down: Array<[number, number]> = clear(edge.from)
          ? [[from.x + W / 2, from.y + H]]
          : [
              [from.x + W, from.y + H / 2],
              [channel(edge.from.column, edge.key), from.y + H / 2],
            ];
        const up: Array<[number, number]> = clear(edge.to)
          ? [[to.x + W / 2, to.y + H]]
          : [
              [channel(edge.to.column - 1, edge.key), port(to, edge.key)],
              [to.x, port(to, edge.key)],
            ];

        const leaves = (down[down.length - 1] as [number, number])[0];
        const returns = (up[0] as [number, number])[0];
        return (
          <g key={edge.key}>
            <path
              className="edge cycle"
              pathLength={1}
              d={orthogonal([...down, [leaves, lane], [returns, lane], ...up])}
              markerEnd="url(#tip-cycle)"
            />
            <text className="limit" x={(leaves + returns) / 2} y={lane + 4}>
              {(edge.cycle as Cycle).limit}×
            </text>
          </g>
        );
      })}

      {forward.map((edge) => (
        <path key={edge.key} className="edge" pathLength={1} d={wire(edge)} markerEnd="url(#tip)" />
      ))}

      {nodes.map((node, index) => (
        <g
          key={node.step.id}
          className={`node ${marks[node.step.id] ?? "idle"} ${selected === node.step.id ? "chosen" : ""}`}
          style={{ "--i": index } as CSSProperties}
          transform={`translate(${node.x} ${node.y})`}
          onClick={() => onSelect?.(node.step.id)}
        >
          <g className="lift">
            {/* A fanout is one step in the file and many in the run, so it stands as a stack. */}
            {node.step.fanout && node.step.fanout.length > 1 && (
              <rect className="box behind" x="5" y="-5" width={W} height={H} rx="12" />
            )}
            <rect className="box" width={W} height={H} rx="12" />
            {marks[node.step.id] === "running" && (
              <rect className="halo" x="-4" y="-4" width={W + 8} height={H + 8} rx="16" />
            )}
            <title>{node.step.id}</title>
            <text className="name" x="15" y="25">
              {short(node.step.id)}
            </text>
            <text className="kind" x="15" y="43">
              {label(node.step)}
            </text>
          </g>
        </g>
      ))}
    </svg>
  );
}

function span(edge: { from: Placed; to: Placed }): number {
  return Math.abs(edge.to.column - edge.from.column);
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
