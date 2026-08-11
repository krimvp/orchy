// The files the writers wrote, in one list.
export default (inputs: Record<string, { file: string }>) => ({
  files: Object.values(inputs)
    .map((one) => one.file)
    .sort(),
});
