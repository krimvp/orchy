import { execFileSync } from "node:child_process";

/** The patch a model reads. A longer one costs tokens and says no more. */
const MOST = 60_000;

/** Room for the whole patch, which git writes before this module cuts it. */
const ROOM = 64 * 1024 * 1024;

/**
 * The branch as git sees it: the base, the files, the subjects, and the patch.
 * The base is a value of the run, because a clone that holds no `main` needs
 * another one, and an environment variable is a knob that no document names.
 * The patch goes with the subjects, because a subject alone makes a model
 * invent the change it describes.
 */
export default (_inputs: unknown, say: (note: string) => void, values: { base?: string }) => {
  const base = values.base ?? "main";
  const git = (...args: string[]) =>
    execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: ROOM });

  try {
    git("rev-parse", "--verify", `${base}^{commit}`);
  } catch {
    throw new Error(
      `this clone holds no commit named "${base}". Supply the base branch, as --with '{"base":"origin/main"}'. A shallow clone holds one commit, so fetch the base first.`,
    );
  }

  const files = git("diff", "--name-only", `${base}...HEAD`).split("\n").filter(Boolean);
  const subjects = git("log", "--format=%s", `${base}..HEAD`).split("\n").filter(Boolean);
  if (subjects.length === 0) {
    throw new Error(
      `HEAD holds no commit that "${base}" does not hold. Supply the branch this work goes over, as --with '{"base":"<branch>"}'.`,
    );
  }

  const patch = git("diff", `${base}...HEAD`);
  say(`${subjects.length} commits and ${files.length} files over ${base}`);
  return { base, files, subjects, diff: cut(patch) };
};

/** A patch that is too long ends with a line that says so. */
function cut(patch: string): string {
  return patch.length > MOST ? `${patch.slice(0, MOST)}\n… the patch stops here. It is longer than this.` : patch;
}
