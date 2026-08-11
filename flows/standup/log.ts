import { execFileSync } from "node:child_process";

/** The patch a model reads. A longer one costs tokens and says no more. */
const MOST = 60_000;

/** Room for the whole patch, which git writes before this module cuts it. */
const ROOM = 64 * 1024 * 1024;

/**
 * What landed in a window of time, with the patch that goes with it. The window
 * is a value of the run, because an environment variable is a knob that no
 * document names. The patch goes with the subjects, because a subject alone
 * makes a model invent the work it describes.
 */
export default (_inputs: unknown, say: (note: string) => void, values: { since?: string }) => {
  const since = values.since ?? "1 day ago";
  const git = (...args: string[]) =>
    execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: ROOM });

  let out: string;
  let patch: string;
  try {
    out = git("log", `--since=${since}`, "--format=%h%x00%s");
    patch = git("log", `--since=${since}`, "--patch", "--format=%n%h %s");
  } catch (error) {
    throw new Error(
      `git cannot read the window "${since}": ${reason(error)}. Supply one it reads, as --with '{"since":"1 day ago"}'.`,
    );
  }

  const commits = out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, subject] = line.split("\0");
      return { hash: hash as string, subject: subject as string };
    });
  say(`${commits.length} commits since ${since}`);
  return { since, commits, diff: cut(patch) };
};

/** What git said, short enough for a message. */
function reason(error: unknown): string {
  return String((error as { stderr?: string }).stderr ?? (error as Error).message)
    .trim()
    .slice(0, 200);
}

/** A patch that is too long ends with a line that says so. */
function cut(patch: string): string {
  return patch.length > MOST ? `${patch.slice(0, MOST)}\n… the patch stops here. It is longer than this.` : patch;
}
