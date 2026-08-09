export default (inputs: Record<string, { checked: string[]; disagreements: unknown[] }>) => {
  const parts = Object.values(inputs);
  return {
    checked: parts.flatMap((part) => part.checked),
    disagreements: parts.flatMap((part) => part.disagreements),
  };
};
