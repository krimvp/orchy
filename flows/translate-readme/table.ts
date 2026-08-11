// One row for each translation, in a stable order.
export default (inputs: Record<string, { language: string; file: string }>) => ({
  translations: Object.values(inputs).sort((a, b) => a.language.localeCompare(b.language)),
});
