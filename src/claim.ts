import { randomUUID } from "node:crypto";
import { linkSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ClaimOwner {
  pid: number;
  identity: string;
  token: string;
  runId?: string;
  workspace?: string;
  root?: string;
}

export interface Claim {
  directory: string;
  file: string;
  owner: ClaimOwner;
  device: number;
  inode: number;
}

export type ClaimRelease = "released" | "absent" | "replaced" | "fault";
export type ClaimInspection =
  | { status: "found"; claim: Claim }
  | { status: "absent"; file: string }
  | { status: "fault"; file: string };

function claimOwner(value: unknown): ClaimOwner | undefined {
  if (!value || typeof value !== "object") return undefined;
  const owner = value as Partial<ClaimOwner>;
  if (!Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0) return undefined;
  if (typeof owner.identity !== "string" || owner.identity.length === 0) return undefined;
  if (typeof owner.token !== "string" || owner.token.length === 0) return undefined;
  if (owner.runId !== undefined && typeof owner.runId !== "string") return undefined;
  if (owner.workspace !== undefined && typeof owner.workspace !== "string") return undefined;
  if (owner.root !== undefined && typeof owner.root !== "string") return undefined;
  return owner as ClaimOwner;
}

/** A process identity includes the boot and process start on Linux, where PID reuse is common. */
export function processIdentity(pid = process.pid): string {
  try {
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    if (start) return `${boot}:${pid}:${start}`;
  } catch {
    // Other systems still get the PID check. The token keeps one owner from
    // removing a later owner's claim.
  }
  return String(pid);
}

export function ownerLives(owner: Pick<ClaimOwner, "pid" | "identity">): boolean {
  try {
    process.kill(owner.pid, 0);
    return processIdentity(owner.pid) === owner.identity;
  } catch {
    return false;
  }
}

/** Publishes one claim without replacing a claim that is already there. */
export function acquireClaim(
  directory: string,
  subject: Omit<Partial<ClaimOwner>, "pid" | "identity" | "token">,
  busy: (owner: ClaimOwner) => string,
  stale: (file: string, owner: ClaimOwner | undefined) => string,
): Claim {
  const file = join(directory, "claim");
  const owner: ClaimOwner = { pid: process.pid, identity: processIdentity(), token: randomUUID(), ...subject };
  const prepared = join(directory, `claim.${owner.token}.json`);
  writeFileSync(prepared, JSON.stringify(owner), { flag: "wx", mode: 0o600 });

  try {
    linkSync(prepared, file);
  } catch {
    const held = ownerOf(file);
    rmSync(prepared);
    if (held && ownerLives(held)) throw new Error(busy(held));
    throw new Error(stale(file, held));
  }

  const stat = lstatSync(file);
  return { directory, file, owner, device: stat.dev, inode: stat.ino };
}

/** Distinguishes a missing claim from one whose owner cannot be trusted. */
export function inspectClaim(directory: string): ClaimInspection {
  const file = join(directory, "claim");
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(file);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { status: "absent", file }
      : { status: "fault", file };
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return { status: "fault", file };
  try {
    const owner = claimOwner(JSON.parse(readFileSync(file, "utf8")));
    if (!owner) return { status: "fault", file };
    return { status: "found", claim: { directory, file, owner, device: stat.dev, inode: stat.ino } };
  } catch {
    return { status: "fault", file };
  }
}

/** Reads an exact claim so another owner can release only that claim later. */
export function readClaim(directory: string): Claim | undefined {
  const inspected = inspectClaim(directory);
  return inspected.status === "found" ? inspected.claim : undefined;
}

/** Removes only the claim with the same owner, device, and inode. */
export function releaseClaim(claim: Claim): ClaimRelease {
  let stat: ReturnType<typeof lstatSync>;
  let owner: ClaimOwner;
  try {
    stat = lstatSync(claim.file);
    const found = claimOwner(JSON.parse(readFileSync(claim.file, "utf8")));
    if (!found) return "fault";
    owner = found;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "fault";
  }
  if (stat.dev !== claim.device || stat.ino !== claim.inode || owner.token !== claim.owner.token) return "replaced";
  try {
    // The runner is the only normal releaser. A daemon reaches this operation
    // only after it proves that the old process group is absent. Therefore no
    // conforming old owner can replace this matching inode before its removal.
    rmSync(claim.file);
    try {
      rmSync(join(claim.directory, `claim.${claim.owner.token}.json`));
    } catch {}
    return "released";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "fault";
  }
}

function ownerOf(file: string): ClaimOwner | undefined {
  try {
    return claimOwner(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    try {
      return claimOwner(JSON.parse(readFileSync(join(file, "owner.json"), "utf8")));
    } catch {
      return undefined;
    }
  }
}

/** Runs one state transition at a time across all Orchy processes over one root. */
export async function claimed<T>(directory: string, runId: string, work: () => Promise<T>): Promise<T> {
  const claim = acquireClaim(
    directory,
    { runId },
    () => `the run ${runId} is already on its way`,
    (file) =>
      `the run ${runId} has a claim with no live owner. Inspect "${file}" and remove it only when no Orchy process drives the run.`,
  );

  try {
    return await work();
  } finally {
    releaseClaim(claim);
  }
}
