import { execFileSync } from "node:child_process";

/** The patch a model reads. A longer one costs tokens and says no more. */
const MOST = 60_000;

/** Room for the whole patch, which git writes before this module cuts it. */
const ROOM = 64 * 1024 * 1024;

/**
 * The commits of a release, with the patch that goes with them. The range is a
 * value of the run, because a clone with no tag needs another one, and an
 * environment variable is a knob that no document names. The patch goes with
 * the subjects, because a subject alone makes a model invent a feature.
 */
export default (_inputs: unknown, say: (note: string) => void, values: { range?: string }) => {
  const git = (...args: string[]) =>
    execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: ROOM });
  const range = values.range ?? lastTag(git);

  let out: string;
  let patch: string;
  try {
    out = git("log", "--format=%h%x00%s", range);
    patch = git("log", "--patch", "--format=%n%h %s", range);
  } catch (error) {
    throw new Error(
      `this clone cannot read the range "${range}": ${reason(error)}. Supply a range it holds, as --with '{"range":"v0.1.0..HEAD"}'. A shallow clone holds one commit, so fetch the history first.`,
    );
  }

  const commits = out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, subject] = line.split("\0");
      return { hash: hash as string, subject: subject as string };
    });
  if (commits.length === 0) {
    throw new Error(`the range "${range}" holds no commit. Supply another, as --with '{"range":"v0.1.0..HEAD"}'.`);
  }

  say(`${commits.length} commits over ${range}`);
  return { range, commits, diff: cut(patch) };
};

/** Everything after the last tag, or the whole history of a clone with no tag. */
function lastTag(git: (...args: string[]) => string): string {
  try {
    return `${git("describe", "--tags", "--abbrev=0").trim()}..HEAD`;
  } catch {
    return "HEAD";
  }
}

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
