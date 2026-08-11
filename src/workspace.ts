import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

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
  /** Where a rename put the file. A promise reads this half as well. */
  to?: string;
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
    .map((path) => changeOf(path, after.files[path]));
  return before.head === after.head ? list : [{ path: "HEAD", how: "moved" as const }, ...list];
}

/**
 * One change, from the path git reports and the state it reports for it. Git
 * writes a rename as `old -> new`, and a promise must read both halves, so the
 * change keeps them apart. See invariant 5.
 */
function changeOf(path: string, state: string | undefined): Change {
  const how = howOf(state);
  const at = path.indexOf(RENAME);
  if (how !== "renamed" || at === -1) return { path, how };
  return { path: path.slice(0, at), to: path.slice(at + RENAME.length), how };
}

/** Git writes a rename as two paths in one line. */
const RENAME = " -> ";

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
  const letters = status.slice(0, 2);
  for (const [letter, how] of HOW) if (letters.includes(letter)) return how;
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
 *
 * Each path keeps the two status characters and a hash of what the file holds.
 * The characters alone say only that the file differs from the repository, and
 * they say the same before and after a second write. So a step that changed a
 * file another step had already changed moved nothing that the two letters
 * report, and invariant 5 lost every such change.
 */
function status(at: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const line of git(["status", "--porcelain", "-uall"], at).split("\n")) {
    if (line.length < 4) continue;
    const path = line.slice(3);
    // The run state of Orchy is not the work of the step.
    if (path.startsWith(".orchy/")) continue;
    const state = line.slice(0, 2);
    files[path] = `${state} ${hashOf(at, path)}`;
  }
  return files;
}

/**
 * What a file holds, as one short word. A path git no longer reads, and a path
 * that is a rename, hash to nothing: the status characters carry those.
 */
function hashOf(at: string, path: string): string {
  if (path.includes(RENAME)) return "";
  try {
    return createHash("sha1").update(readFileSync(join(at, path))).digest("hex").slice(0, 16);
  } catch {
    return "";
  }
}
