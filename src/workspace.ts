import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmdirSync } from "node:fs";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { type Claim, type ClaimRelease, acquireClaim, inspectClaim, processIdentity, releaseClaim } from "./claim.ts";

/**
 * A tagged value, so a remote sandbox becomes a new kind and not a change to
 * the format. See ADR 0006.
 */
export type Workspace = { kind: "none" } | { kind: "git"; path: string };

export interface Snapshot {
  head: string;
  files: Record<string, string>;
}

export interface WorkspaceClaim extends Claim {
  workspace: string;
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
  checkWorkspace(workspace, cwd);
  return { head: git(["rev-parse", "--verify", "HEAD"], at, true).trim(), files: status(at) };
}

/** Checks that Git can read a declared workspace, without taking a snapshot. */
export function checkWorkspace(workspace: Workspace | undefined, cwd: string): void {
  if (!workspace || workspace.kind === "none") return;

  const at = resolve(cwd, workspace.path);
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd: at, stdio: "pipe" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && existsSync(at)) {
      throw new Error("the git command is not on PATH");
    }
    throw new Error(`the workspace at "${at}" is not a git repository`);
  }
}

/** Claims one canonical Git working tree for one active run. */
export function claimWorkspace(workspace: Workspace | undefined, cwd: string, runId: string): WorkspaceClaim | undefined {
  const canonical = workspaceIdentity(workspace, cwd);
  if (!canonical) return undefined;
  const directory = claimDirectory(canonical);
  const claim = acquireClaim(
    directory,
    { runId, workspace: canonical, root: realpathSync.native(resolve(cwd)) },
    (owner) =>
      `the Git workspace at "${canonical}" is in use by run ${owner.runId ?? "unknown"} in process ${owner.pid}. Wait for that active execution to end.`,
    (file, owner) => staleWorkspace(canonical, file, owner),
  );
  return { ...claim, workspace: canonical };
}

/** Pins the claim of one live daemon child before the daemon signals it. */
export function pinWorkspaceClaim(
  workspace: Workspace | undefined,
  cwd: string,
  runId: string,
  pid: number,
  identity = processIdentity(pid),
): WorkspaceClaim | undefined {
  const canonical = workspaceIdentity(workspace, cwd);
  if (!canonical) return undefined;
  const inspected = inspectClaim(claimDirectory(canonical));
  if (inspected.status === "fault") throw new Error(staleWorkspace(canonical, inspected.file, undefined));
  if (inspected.status === "absent") return undefined;
  const held = inspected.claim;
  if (
    !held ||
    held.owner.runId !== runId ||
    held.owner.workspace !== canonical ||
    held.owner.pid !== pid ||
    held.owner.identity !== identity
  ) {
    return undefined;
  }
  return { ...held, workspace: canonical };
}

/** Releases only the exact workspace claim that the caller acquired or pinned. */
export function releaseWorkspaceClaim(claim: WorkspaceClaim | undefined): ClaimRelease {
  if (!claim) return "absent";
  const released = releaseClaim(claim);
  if (released === "released") {
    try {
      rmdirSync(claim.directory);
    } catch {}
  }
  return released;
}

/** Gives a failed cleanup the claim and the condition for manual recovery. */
export function workspaceClaimCleanup(claim: Pick<WorkspaceClaim, "file">, released: ClaimRelease): string {
  const reason =
    released === "fault" ? "the claim could not be read or removed" : "another process removed or replaced the claim";
  return `Orchy could not release the workspace claim at "${claim.file}": ${reason}. Inspect it, and remove it only after the owner process and its descendants have ended.`;
}

/** The identity is the working tree, so aliases collide and Git worktrees do not. */
export function workspaceIdentity(workspace: Workspace | undefined, cwd: string): string | undefined {
  if (!workspace || workspace.kind === "none") return undefined;
  const at = resolve(cwd, workspace.path);
  let top: string;
  try {
    top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: at, encoding: "utf8", stdio: "pipe" }).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && existsSync(at)) {
      throw new Error("the git command is not on PATH");
    }
    throw new Error(`the workspace at "${at}" is not a git repository`);
  }
  const canonical = realpathSync.native(top);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function staleWorkspace(workspace: string, file: string, owner: Claim["owner"] | undefined): string {
  const who = owner
    ? `Run ${owner.runId ?? "unknown"} claimed it in process ${owner.pid}, but that owner is not live.`
    : "The claim owner record is not readable.";
  const root = owner?.root;
  const state = owner?.runId && root ? join(root, ".orchy", "runs", owner.runId, "state.json") : undefined;
  const inspect = state
    ? ` Run "orchy runs" in "${root}", and inspect "${state}" and "${file}".`
    : ` Inspect "${file}".`;
  return `the Git workspace at "${workspace}" has a stale claim. ${who}${inspect} Remove the claim only after the owner process and its descendants have ended.`;
}

/** The OS account path stays the same when HOME, XDG, or TMPDIR changes. */
function claimDirectory(workspace: string): string {
  const home = realpathSync.native(userInfo().homedir);
  const base = join(home, ".orchy-workspace-claims");
  privateDirectory(base);
  const key = createHash("sha256").update(workspace).digest("hex");
  const directory = join(base, key);
  privateDirectory(directory);
  return directory;
}

/** Refuses a shared or redirected claim directory instead of weakening the claim. */
function privateDirectory(directory: string): void {
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = lstatSync(directory);
  const uid = process.getuid?.();
  const unsafeMode = process.platform !== "win32" && (stat.mode & 0o077) !== 0;
  if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid) || unsafeMode) {
    throw new Error(`the workspace claim directory at "${directory}" is not a private directory owned by this user`);
  }
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

/** A file name cannot hold NUL, so it keeps the two names of a rename apart. */
const RENAME = "\0";

/** The status letters, in the order they alarm a reader. The first one wins. */
const HOW: Array<[string, Change["how"]]> = [
  ["D", "deleted"],
  ["R", "renamed"],
  ["C", "added"],
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
function git(args: string[], cwd: string, allowFailure = false): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
  } catch (error) {
    if (allowFailure) return "";
    const detail = error as { stderr?: Buffer | string; message?: string };
    const reason = String(detail.stderr ?? detail.message ?? error).trim();
    throw new Error(`git could not record the workspace${reason ? `: ${reason}` : ""}`);
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
  const fields = git(["status", "--porcelain=v1", "-z", "-uall"], at).split("\0");
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] as string;
    if (field.length < 4) continue;
    const state = field.slice(0, 2);
    const to = field.slice(3);
    const paired = state.includes("R") || state.includes("C");
    // Under `-z`, Git writes the new name first and the old name in the next field.
    const from = paired ? (fields[(index += 1)] as string | undefined) : undefined;
    const path = state.includes("R") && from !== undefined ? `${from}${RENAME}${to}` : to;
    // The run state of Orchy is not the work of the step.
    if (to === ".orchy" || to.startsWith(".orchy/")) continue;
    files[path] = `${state} ${hashOf(at, to)}`;
  }
  return files;
}

/**
 * What a file holds, as one short word. A path git no longer reads, and a path
 * that is a rename, hash to nothing: the status characters carry those.
 */
function hashOf(at: string, path: string): string {
  try {
    const full = join(at, path);
    const stat = lstatSync(full);
    const value = stat.isSymbolicLink() ? readlinkSync(full) : stat.isFile() ? readFileSync(full) : Buffer.alloc(0);
    // Git records the executable bit. Include it so two mode changes are visible.
    return createHash("sha1")
      .update(stat.isSymbolicLink() ? "link\0" : `file\0${stat.mode & 0o111}\0`)
      .update(value)
      .digest("hex")
      .slice(0, 16);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw new Error(`the workspace cannot hash "${path}": ${error instanceof Error ? error.message : String(error)}`);
  }
}
