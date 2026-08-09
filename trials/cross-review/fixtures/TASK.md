# Make `parseDuration` handle the units the docs promise

`src/duration.js` parses a duration string into milliseconds. The README of
this little library says it accepts `ms`, `s`, `m`, `h`, `d`, and `w`, a
leading `-` for a negative duration, and a decimal point.

It does not. Fix it.

Rules:

- `"1.5h"` is 5400000. Decimals are allowed on any unit.
- `"-30m"` is -1800000.
- `"2w"` is 1209600000.
- Whitespace around the string is ignored: `" 10s "` is 10000.
- A bare number with no unit means milliseconds: `"250"` is 250.
- An empty string, a unit with no number, and an unknown unit all throw a
  `TypeError` whose message names the input.
- The function must stay synchronous and take no dependency.

`test/expected.json` holds the cases. Do not change it, and do not change this
file.
