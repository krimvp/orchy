// Approval is unanimous, and every finding survives the merge.
export default (inputs: Record<string, { approved: boolean; findings: string[] }>) => {
  const votes = Object.values(inputs);
  return {
    approved: votes.every((one) => one.approved),
    findings: votes.flatMap((one) => one.findings),
  };
};
