import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * A tagged value, so a remote sandbox becomes a new kind and not a change to
 * the format. See ADR 0006.
 */
export type Workspace = { kind: "none" } | { kind: "git"; path: string };

export interface Snapshot {
  head: string;
  files: Record<string, string>;
}

/**
 * What a step did to one path. Invariant 5 records the kind of the change and
 * not only the path, because a person who reads "changed" and means "deleted"
 * loses the worst case in the vaguest word. `moved` belongs to HEAD alone.
 */
export interface Change {
  path: string;
  how: "added" | "changed" | "deleted" | "renamed" | "restored" | "moved";
}

/** A workspace that records nothing returns nothing, and invariant 5 stays quiet. */
export function take(workspace: Workspace | undefined, cwd: string): Snapshot | undefined {
  if (!workspace || workspace.kind === "none") return undefined;

  const at = resolve(cwd, workspace.path);
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd: at, stdio: "pipe" });
  } catch {
    throw new Error(`the workspace at "${at}" is not a git repository`);
  }

  return { head: git(["rev-parse", "HEAD"], at).trim(), files: status(at) };
}

export function changed(before: Snapshot | undefined, after: Snapshot | undefined): Change[] {
  if (!before || !after) return [];

  const paths = new Set([...Object.keys(before.files), ...Object.keys(after.files)]);
  const list = [...paths]
    .filter((path) => before.files[path] !== after.files[path])
    .sort()
    .map((path) => ({ path, how: howOf(after.files[path]) }));
  return before.head === after.head ? list : [{ path: "HEAD", how: "moved" }, ...list];
}

/** The status letters, in the order they alarm a reader. The first one wins. */
const HOW: Array<[string, Change["how"]]> = [
  ["D", "deleted"],
  ["R", "renamed"],
  ["?", "added"],
  ["A", "added"],
];

/**
 * The two status characters of git, as one word. A path that git no longer
 * reports is back as the repository holds it, which a commit or an undo does.
 */
function howOf(status: string | undefined): Change["how"] {
  if (status === undefined) return "restored";
  for (const [letter, how] of HOW) if (status.includes(letter)) return how;
  return "changed";
}

/**
 * The output keeps its leading space. A porcelain line starts with two status
 * characters, and the first is a space for a file that only the working tree
 * changed. Trimming here eats the first letter of that path.
 */
function git(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
  } catch {
    return "";
  }
}

/**
 * `-uall` names every untracked file. Without it git collapses a new directory
 * into one entry, such as `docs/`, and a promise about paths cannot read that.
 */
function status(at: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const line of git(["status", "--porcelain", "-uall"], at).split("\n")) {
    if (line.length < 4) continue;
    const path = line.slice(3);
    // The run state of Orchy is not the work of the step.
    if (path.startsWith(".orchy/")) continue;
    files[path] = line.slice(0, 2);
  }
  return files;
}
