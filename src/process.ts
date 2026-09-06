import { type ChildProcess, type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

/** A daemon child and each process it starts stay in this process group. */
export const RUN_GROUP = "ORCHY_RUN_GROUP";

/** A process gets this long to stop before Orchy forces it to end. */
export const STOP_GRACE = 750;

/** A command value stays small enough to keep in one run state. */
export const COMMAND_OUTPUT = 4 * 1024 * 1024;

export interface OwnedCommand {
  child: ChildProcessWithoutNullStreams;
  result: Promise<{ stdout: string; stderr: string }>;
}

/** A direct CLI child owns a group. A daemon child already owns the run group. */
export function ownsGroup(): boolean {
  return process.env[RUN_GROUP] !== "1";
}

/** Waits until a process tree ends after a graceful stop, then forces it. */
export async function terminate(child: ChildProcess, group: boolean): Promise<void> {
  const pid = child.pid;
  if (!pid) return;

  if (process.platform === "win32" && group) {
    if (await taskkill(pid, false)) return;
    await wait(STOP_GRACE);
    if (await taskkill(pid, true)) return;
    throw new Error(`the process tree ${pid} did not end after taskkill forced it`);
  }

  signal(child, group, "SIGTERM");
  if (group) {
    if (await untilGone(pid, STOP_GRACE)) return;
    signal(child, true, "SIGKILL");
    if (!(await untilGone(pid, STOP_GRACE))) {
      throw new Error(`the process group ${pid} did not end after SIGKILL`);
    }
    return;
  }

  if (await untilClosed(child, STOP_GRACE)) return;
  signal(child, false, "SIGKILL");
  if (!(await untilClosed(child, STOP_GRACE))) {
    throw new Error(`the process ${pid} did not end after SIGKILL`);
  }
}

/** Runs a command with bounded output and an owned tree outside a daemon run. */
export function execOwned(
  file: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; maxBuffer: number },
  abort?: AbortSignal,
): OwnedCommand {
  const grouped = ownsGroup();
  const child = spawn(file, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: grouped && process.platform !== "win32",
  });
  const stopped = cancelChild(child, abort, grouped);
  let stdout = "";
  let stderr = "";
  let outBytes = 0;
  let errorBytes = 0;
  let fault: Error | undefined;
  let outputStop: Promise<void> | undefined;

  const take = (name: "stdout" | "stderr", chunk: Buffer) => {
    if (fault) return;
    if (name === "stdout") {
      outBytes += chunk.length;
      stdout += chunk.toString();
      if (outBytes <= options.maxBuffer) return;
    } else {
      errorBytes += chunk.length;
      stderr += chunk.toString();
      if (errorBytes <= options.maxBuffer) return;
    }
    fault = new Error(`${file} wrote more than ${options.maxBuffer} bytes to ${name}`);
    outputStop = terminate(child, grouped);
  };
  child.stdout.on("data", (chunk: Buffer) => take("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => take("stderr", chunk));
  child.on("error", (error) => (fault ??= error));

  const result = new Promise<{ stdout: string; stderr: string }>((keep, refuse) => {
    child.on("close", (code) => {
      void (async () => {
        try {
          await outputStop;
          await stopped();
          if (abort?.aborted) throw cancellation(abort);
          if (fault) throw fault;
          if (code !== 0) throw Object.assign(new Error(`${file} ended with the code ${code}`), { code });
          keep({ stdout, stderr });
        } catch (error) {
          refuse(Object.assign(error instanceof Error ? error : new Error(String(error)), { stdout, stderr, code }));
        }
      })();
    });
  });
  return { child, result };
}

/** Connects an abort signal to one child and lets its caller await the stop. */
export function cancelChild(child: ChildProcess, signal: AbortSignal | undefined, group: boolean): () => Promise<void> {
  let stopping: Promise<void> | undefined;
  const stop = () => (stopping ??= terminate(child, group));
  if (signal?.aborted) void stop();
  else signal?.addEventListener("abort", stop, { once: true });
  return async () => {
    signal?.removeEventListener("abort", stop);
    if (stopping) await stopping;
  };
}

/** The error that a cancelled run records nowhere as a step failure. */
export function cancellation(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("the run was stopped");
}

function signal(child: ChildProcess, group: boolean, name: NodeJS.Signals): void {
  try {
    if (group && child.pid) process.kill(-child.pid, name);
    else child.kill(name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function untilGone(pid: number, timeout: number): Promise<boolean> {
  const end = Date.now() + timeout;
  do {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      throw error;
    }
    await wait(20);
  } while (Date.now() < end);
  return false;
}

function untilClosed(child: ChildProcess, timeout: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((done) => {
    const timer = setTimeout(() => {
      child.removeListener("close", close);
      done(false);
    }, timeout);
    const close = () => {
      clearTimeout(timer);
      done(true);
    };
    child.once("close", close);
  });
}

function taskkill(pid: number, force: boolean): Promise<boolean> {
  return new Promise((done) => {
    const child = spawn("taskkill", ["/pid", String(pid), "/t", ...(force ? ["/f"] : [])], { stdio: "ignore" });
    child.on("error", () => done(false));
    child.on("close", (code) => done(code === 0));
  });
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((done) => setTimeout(done, milliseconds));
}
