// One list from three sweeps, each finding tagged with the area that found it.
type Sweep = { area: string; findings: { file: string; what: string; severity: string }[] };

export default (inputs: Record<string, Sweep>) => {
  const findings = Object.values(inputs).flatMap((one) =>
    one.findings.map((finding) => ({ ...finding, area: one.area })),
  );
  return {
    total: findings.length,
    high: findings.filter((one) => one.severity === "high").length,
    findings,
  };
};
