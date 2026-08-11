// The spread of the estimates. They agree when the widest gap is a day.
export default (inputs: Record<string, { days: number }>) => {
  const days = Object.values(inputs).map((one) => one.days);
  const low = Math.min(...days);
  const high = Math.max(...days);
  const mean = days.reduce((sum, one) => sum + one, 0) / days.length;
  return { low, high, mean, agree: high - low <= 1 };
};
