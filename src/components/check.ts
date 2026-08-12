import { spawn } from "node:child_process";

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
): Promise<{ ok: true }> =>
  new Promise((keep, refuse) => {
    const run = typeof values.run === "string" ? values.run : "";
    if (!run) {
      return refuse(new Error('the check holds no command. Name one on the step, as with: { run: "npm test" }.'));
    }
    const child = spawn(run, { cwd: cwd ?? process.cwd(), shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let said = "";
    let rest = "";
    const hear = (chunk: Buffer) => {
      said = `${said}${chunk.toString()}`.slice(-4000);
      const parts = `${rest}${chunk.toString()}`.split("\n");
      rest = parts.pop() ?? "";
      for (const line of parts) if (line.trim()) say(line);
    };
    child.stdout.on("data", hear);
    child.stderr.on("data", hear);
    child.on("error", (error) => refuse(new Error(`the check could not run "${run}": ${error.message}`)));
    child.on("close", (code) => {
      if (rest.trim()) say(rest);
      if (code === 0) return keep({ ok: true });
      refuse(new Error(`the check "${run}" ended with the code ${code}:\n${said.trim() || "and said nothing"}`));
    });
  });
