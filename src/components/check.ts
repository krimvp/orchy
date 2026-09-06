import { spawn } from "node:child_process";
import type { Called } from "../run.ts";
import { cancelChild, cancellation, ownsGroup } from "../process.ts";

/**
 * A check: runs a command, and passes only when it ends with 0. The command
 * comes as `with: { run: "npm test" }` on the step, in any language — the
 * exit code is the whole protocol, so the output need not be JSON. Each line
 * the command writes is a live note, a pass answers `{ ok: true }`, and a
 * failure fails the step with the last of what the command said, so a cycle
 * sends the reason back to the step it checks. ADR 0026.
 */
export default (
  _inputs: Record<string, unknown>,
  say: (text: string) => void,
  values: Record<string, unknown>,
  cwd?: string,
  called?: Called,
): Promise<{ ok: true }> =>
  new Promise((keep, refuse) => {
    const run = typeof values.run === "string" ? values.run : "";
    if (!run) {
      return refuse(new Error('the check holds no command. Name one on the step, as with: { run: "npm test" }.'));
    }
    const grouped = ownsGroup();
    const child = spawn(run, {
      cwd: cwd ?? process.cwd(),
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: grouped && process.platform !== "win32",
    });
    const stopped = cancelChild(child, called?.signal, grouped);
    let said = "";
    let rest = "";
    const hear = (chunk: Buffer) => {
      said = `${said}${chunk.toString()}`.slice(-4000);
      const parts = `${rest}${chunk.toString()}`.split("\n");
      rest = (parts.pop() ?? "").slice(-4000);
      for (const line of parts) if (line.trim()) say(line.slice(0, 4000));
    };
    child.stdout.on("data", hear);
    child.stderr.on("data", hear);
    child.on("error", (error) => refuse(new Error(`the check could not run "${run}": ${error.message}`)));
    child.on("close", (code) => {
      void (async () => {
        await stopped();
        if (called?.signal?.aborted) return refuse(cancellation(called.signal));
        if (rest.trim()) say(rest);
        if (code === 0) return keep({ ok: true });
        refuse(new Error(`the check "${run}" ended with the code ${code}:\n${said.trim() || "and said nothing"}`));
      })();
    });
  });
