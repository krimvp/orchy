// The person overrides the agent. A gate exists for that reason.
export default (inputs: Record<string, Record<string, string>>) => {
  const { read, confirm } = inputs;
  const kind = confirm?.kind ?? read?.kind;
  const severity = confirm?.severity ?? read?.severity;
  const labels = [`kind/${kind}`, `severity/${severity}`];
  if ((read?.missing as unknown as string[])?.length) labels.push("needs-info");
  return { labels };
};
