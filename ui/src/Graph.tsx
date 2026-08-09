import type { CSSProperties } from "react";
import { type Cycle, type Step, computedOf, membersOf } from "./api";

export type Mark = "done" | "failed" | "skipped" | "running" | "waiting" | "idle";

const W = 184;
const H = 58;
const GAP_X = 72;
const GAP_Y = 26;
const PAD = 14;
/** The distance between two lanes that carry an edge past the steps. */
const LANE = 24;
const CORNER = 9;
/** The half width of the step that one edge makes over another. */
const HOP = 5;

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

type Point = [number, number];

/** The corners of an edge, with a corner that goes nowhere taken out. */
function corners(points: Point[]): Point[] {
  return points.filter(
    (point, index) => index === 0 || point[0] !== points[index - 1]?.[0] || point[1] !== points[index - 1]?.[1],
  );
}

/** Each pair of corners, which is one flat or upright run of the edge. */
function runs(points: Point[]): Array<[Point, Point]> {
  return points.slice(0, -1).map((point, index) => [point, points[index + 1] as Point]);
}

const length = (a: Point, b: Point) => Math.hypot(b[0] - a[0], b[1] - a[1]);

function toward(a: Point, b: Point, by: number): Point {
  const far = length(a, b) || 1;
  return [a[0] + ((b[0] - a[0]) * by) / far, a[1] + ((b[1] - a[1]) * by) / far];
}

/**
 * A path of straight lines, with a round corner at each turn. Every segment is
 * flat or upright, so the drawing reads as a diagram and not as a sketch.
 *
 * `hops` names, for each run of the edge, the places where it meets a run of
 * another edge. The edge steps over each one, so a reader sees which line
 * carries on and which line passes under.
 */
function orthogonal(points: Point[], hops: Map<number, number[]> = new Map()): string {
  const count = points.length;
  const first = points[0];
  if (!first || count < 2) return "";

  const radius = points.map((_point, index) =>
    index === 0 || index === count - 1
      ? 0
      : Math.min(
          CORNER,
          length(points[index - 1] as Point, points[index] as Point) / 2,
          length(points[index] as Point, points[index + 1] as Point) / 2,
        ),
  );

  let d = "";
  for (let index = 0; index < count - 1; index += 1) {
    const a = points[index] as Point;
    const b = points[index + 1] as Point;
    const from = radius[index] ? toward(a, b, radius[index] as number) : a;
    const to = radius[index + 1] ? toward(b, a, radius[index + 1] as number) : b;
    if (index === 0) d += `M ${from[0]} ${from[1]}`;

    const meets = hops.get(index);
    if (meets && a[1] === b[1]) {
      const way = to[0] > from[0] ? 1 : -1;
      let held = from[0];
      for (const x of [...meets].sort((one, two) => (one - two) * way)) {
        const enter = x - HOP * way;
        const leave = x + HOP * way;
        // A step needs a straight run before it and after it, or it deforms.
        if ((enter - held) * way < 1 || (to[0] - leave) * way < 1) continue;
        // The arc always rises, whichever way the edge travels.
        d += ` L ${enter} ${a[1]} A ${HOP} ${HOP} 0 0 ${way > 0 ? 1 : 0} ${leave} ${a[1]}`;
        held = leave;
      }
    }

    d += ` L ${to[0]} ${to[1]}`;
    if (radius[index + 1]) {
      const next = toward(b, points[index + 2] as Point, radius[index + 1] as number);
      d += ` Q ${b[0]} ${b[1]} ${next[0]} ${next[1]}`;
    }
  }
  return d;
}

/**
 * Where a flat run of one edge crosses an upright run of another. A flat run
 * steps over an upright one, always, so two edges never both step at one place.
 */
function crossings(points: Point[], bars: Array<{ key: string; x: number; top: number; foot: number }>, key: string) {
  const found = new Map<number, number[]>();
  runs(points).forEach(([a, b], index) => {
    if (a[1] !== b[1]) return;
    const y = a[1];
    const low = Math.min(a[0], b[0]);
    const high = Math.max(a[0], b[0]);
    const cuts = bars
      .filter((bar) => bar.key !== key && bar.x > low + 1 && bar.x < high - 1 && y > bar.top + 1 && y < bar.foot - 1)
      .map((bar) => bar.x);
    if (cuts.length > 0) found.set(index, cuts);
  });
  return found;
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
   * An edge leaves by its own place on the right side of a step, in the order
   * the edges go. Without this, every edge out of one step covers the same
   * line, and a line that arrives at one height covers a line that leaves at
   * that height. Then a reader sees a join that the flow does not hold.
   */
  const going = [
    ...forward.map((edge) => ({
      key: edge.key,
      from: edge.from.step.id,
      at: edge.far ? -1000 + (above.get(edge.key) ?? 0) : port(put.get(edge.to.step.id) as Placed, edge.key),
    })),
    ...loops
      .filter((edge) => !clear(edge.from))
      .map((edge) => ({ key: edge.key, from: edge.from.step.id, at: 100_000 })),
  ];
  const leaving = new Map<string, string[]>();
  for (const node of nodes) {
    leaving.set(
      node.step.id,
      going
        .filter((one) => one.from === node.step.id)
        .sort((a, b) => a.at - b.at)
        .map((one) => one.key),
    );
  }
  const exit = (node: Placed, key: string): number => {
    const held = leaving.get(node.step.id) ?? [];
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
    } else if (exit(from, edge.key) !== port(to, edge.key)) {
      // An edge that leaves and arrives at one height needs no turn at all.
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

  const wireOf = (edge: (typeof forward)[number]): Point[] => {
    const from = put.get(edge.from.step.id) as Placed;
    const to = put.get(edge.to.step.id) as Placed;
    const start: Point = [from.x + W, exit(from, edge.key)];
    const end: Point = [to.x, port(to, edge.key)];

    if (edge.far) {
      const lane = above.get(edge.key) as number;
      const out = channel(from.column, edge.key);
      const into = channel(to.column - 1, edge.key);
      return corners([start, [out, start[1]], [out, lane], [into, lane], [into, end[1]], end]);
    }
    if (start[1] === end[1]) return [start, end];
    const turn = channel(from.column, edge.key);
    return corners([start, [turn, start[1]], [turn, end[1]], end]);
  };

  const loopOf = (edge: (typeof loops)[number]) => {
    const from = put.get(edge.from.step.id) as Placed;
    const to = put.get(edge.to.step.id) as Placed;
    const lane = below.get(edge.key) as number;

    // A step that cycles to itself is a retry. It leaves and returns at its own
    // foot, so each end takes a place of its own. One point draws no loop.
    const self = edge.from.step.id === edge.to.step.id;
    const foot = (node: Placed, side: number): Point => [node.x + W / 2 + (self ? side * 16 : 0), node.y + H];

    // The foot of a step, when nothing stands below it. The gap beside it when
    // something does.
    const down: Point[] = clear(edge.from)
      ? [foot(from, 1)]
      : [
          [from.x + W, exit(from, edge.key)],
          [channel(edge.from.column, edge.key), exit(from, edge.key)],
        ];
    const up: Point[] = clear(edge.to)
      ? [foot(to, -1)]
      : [
          [channel(edge.to.column - 1, edge.key), port(to, edge.key)],
          [to.x, port(to, edge.key)],
        ];

    const leaves = (down[down.length - 1] as Point)[0];
    const returns = (up[0] as Point)[0];
    return {
      points: corners([...down, [leaves, lane], [returns, lane], ...up]),
      label: { x: (leaves + returns) / 2, y: lane + 4, text: `${(edge.cycle as Cycle).limit}×` },
    };
  };

  // Every edge is built before any is drawn, so each one knows where it crosses
  // another and can step over it.
  const wires = [
    ...forward.map((edge) => ({ key: edge.key, cycle: false, points: wireOf(edge), label: undefined })),
    ...loops.map((edge) => ({ key: edge.key, cycle: true, ...loopOf(edge) })),
  ];
  const bars = wires.flatMap((one) =>
    runs(one.points)
      .filter(([a, b]) => a[0] === b[0])
      .map(([a, b]) => ({
        key: one.key,
        x: a[0],
        top: Math.min(a[1], b[1]),
        foot: Math.max(a[1], b[1]),
      })),
  );

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

      {wires.map((one) => (
        <g key={one.key}>
          <path
            className={one.cycle ? "edge cycle" : "edge"}
            pathLength={1}
            d={orthogonal(one.points, crossings(one.points, bars, one.key))}
            markerEnd={one.cycle ? "url(#tip-cycle)" : "url(#tip)"}
          />
          {one.label && (
            <text className="limit" x={one.label.x} y={one.label.y}>
              {one.label.text}
            </text>
          )}
        </g>
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
            {stacked(node.step) && <rect className="box behind" x="5" y="-5" width={W} height={H} rx="12" />}
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

/** A step that runs more than once stands as a stack, whoever names the list. */
function stacked(step: Step): boolean {
  const members = membersOf(step);
  return members ? members.length > 1 : Boolean(computedOf(step));
}

function label(step: Step): string {
  // A computed fanout has no count until the run produces the list. See ADR 0017.
  const many = countOf(step);
  if (step.kind === "agent") {
    return `${short([step.harness ?? "the default", step.model].filter(Boolean).join(" · "), 24)}${many}`;
  }
  if (step.kind === "call") return `${file(step.module ?? "call")}${many}`;
  if (step.kind === "gate") return "a person answers";
  return file(step.flow ?? "flow");
}

/** The number of members, or `×?` when the run computes the list. */
function countOf(step: Step): string {
  const members = membersOf(step);
  if (members) return members.length > 0 ? ` ×${members.length}` : "";
  return computedOf(step) ? " ×?" : "";
}
