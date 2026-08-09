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

/** A workspace that records nothing returns nothing, and invariant 5 stays quiet. */
export function take(workspace: Workspace | undefined, cwd: string): Snapshot | undefined {
  if (!workspace || workspace.kind === "none") return undefined;

  const at = resolve(cwd, workspace.path);
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd: at, stdio: "pipe" });
  } catch {
    throw new Error(`the workspace at "${at}" is not a git repository`);
  }

  return { head: git(["rev-parse", "HEAD"], at), files: status(at) };
}

export function changed(before: Snapshot | undefined, after: Snapshot | undefined): string[] {
  if (!before || !after) return [];

  const paths = new Set([...Object.keys(before.files), ...Object.keys(after.files)]);
  const moved = [...paths].filter((path) => before.files[path] !== after.files[path]).sort();
  return before.head === after.head ? moved : ["HEAD", ...moved];
}

/** A repository with no commit answers nothing, which is a valid starting point. */
function git(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  } catch {
    return "";
  }
}

function status(at: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const line of git(["status", "--porcelain"], at).split("\n")) {
    if (line.length < 4) continue;
    const path = line.slice(3);
    // The run state of Orchy is not the work of the step.
    if (path.startsWith(".orchy/")) continue;
    files[path] = line.slice(0, 2);
  }
  return files;
}
