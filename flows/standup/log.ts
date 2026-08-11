import { execFileSync } from "node:child_process";

// ORCHY_SINCE names the window, and defaults to one day.
export default (_inputs: unknown, say: (note: string) => void) => {
  const since = process.env.ORCHY_SINCE ?? "1 day ago";
  const out = execFileSync("git", ["log", `--since=${since}`, "--format=%h%x00%s"], {
    encoding: "utf8",
  });
  const commits = out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, subject] = line.split("\0");
      return { hash: hash as string, subject: subject as string };
    });
  say(`${commits.length} commits since ${since}`);
  return { since, commits };
};
