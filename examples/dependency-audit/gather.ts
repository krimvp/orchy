// One finding for each member of the fanout, keyed by the id of its step.
export default (inputs: Record<string, { risky: boolean }>) => {
  const findings = Object.values(inputs);
  return { risky: findings.some((one) => one.risky), findings };
};
