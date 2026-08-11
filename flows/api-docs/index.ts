import { mkdirSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

/** Where the writers write, and where the index goes with them. */
const HOME = "docs/api";

/**
 * The index the step is named for: one line for each page the writers wrote.
 * The step wrote no file for a while, and its name said that it did.
 */
export default (inputs: Record<string, { file: string }>, say: (note: string) => void) => {
  const pages = Object.values(inputs)
    .map((one) => one.file)
    .sort();
  const lines = pages.map((page) => `- [${basename(page, ".md")}](./${basename(page)})`);
  const index = `${HOME}/README.md`;

  mkdirSync(HOME, { recursive: true });
  writeFileSync(index, `# The API\n\nOne page for each module under \`src\`.\n\n${lines.join("\n")}\n`);
  say(`${pages.length} pages in ${index}`);
  return { files: [...pages, index].sort() };
};
