import { execFileSync } from "node:child_process";

// ORCHY_RANGE names the commits, and defaults to the last tag onward.
export default () => {
  const range = process.env.ORCHY_RANGE ?? lastTag();
  const out = execFileSync("git", ["log", "--format=%h%x00%s", range], { encoding: "utf8" });
  const commits = out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, subject] = line.split("\0");
      return { hash: hash as string, subject: subject as string };
    });
  return { range, commits };
};

function lastTag(): string {
  try {
    return `${execFileSync("git", ["describe", "--tags", "--abbrev=0"], { encoding: "utf8" }).trim()}..HEAD`;
  } catch {
    return "HEAD~20..HEAD";
  }
}
