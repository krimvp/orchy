// Parses a duration string into milliseconds.
const UNITS = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
};

export function parseDuration(input) {
  const match = /^(\d+)(ms|s|m|h)$/.exec(input);
  if (!match) throw new TypeError("bad duration");
  return Number(match[1]) * UNITS[match[2]];
}
