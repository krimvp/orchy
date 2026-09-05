import { randomUUID } from "node:crypto";
import { linkSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Owner {
  pid: number;
  identity: string;
  token: string;
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

export function ownerLives(owner: Pick<Owner, "pid" | "identity">): boolean {
  try {
    process.kill(owner.pid, 0);
    return processIdentity(owner.pid) === owner.identity;
  } catch {
    return false;
  }
}

/** Runs one state transition at a time across all Orchy processes over one root. */
export async function claimed<T>(directory: string, runId: string, work: () => Promise<T>): Promise<T> {
  const lock = join(directory, "claim");
  const owner: Owner = { pid: process.pid, identity: processIdentity(), token: randomUUID() };
  const prepared = join(directory, `claim.${owner.token}.json`);
  writeFileSync(prepared, JSON.stringify(owner), { flag: "wx" });

  try {
    linkSync(prepared, lock);
  } catch {
    let held: Owner | undefined;
    try {
      held = JSON.parse(readFileSync(lock, "utf8")) as Owner;
    } catch {
      try {
        held = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")) as Owner;
      } catch {}
    }
    rmSync(prepared);
    if (held && ownerLives(held)) throw new Error(`the run ${runId} is already on its way`);
    throw new Error(
      `the run ${runId} has a claim with no live owner. Inspect "${lock}" and remove it only when no Orchy process drives the run.`,
    );
  }

  try {
    return await work();
  } finally {
    try {
      const held = JSON.parse(readFileSync(lock, "utf8")) as Owner;
      if (held.token === owner.token) rmSync(lock, { recursive: true });
    } catch {
      // A missing claim needs no cleanup.
    }
    try {
      rmSync(prepared);
    } catch {}
  }
}
