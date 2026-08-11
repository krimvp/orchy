import { readdirSync } from "node:fs";

// One member for each source file. The run expands the fanout from this list.
export default (_inputs: unknown, say: (note: string) => void) => {
  const modules = readdirSync("src")
    .filter((file) => file.endsWith(".ts"))
    .map((file) => ({ name: file.replace(/\.ts$/, ""), file: `src/${file}` }));
  say(`${modules.length} modules under src`);
  return { modules };
};
