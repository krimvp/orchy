# duration

One function. It turns `"1.5h"` into milliseconds.

```js
import { parseDuration } from "./src/duration.js";

parseDuration("1.5h"); // 5400000
parseDuration("-30m"); // -1800000
parseDuration("250"); // 250
```

Units: `ms`, `s`, `m`, `h`, `d`, `w`. A leading `-` negates. A decimal point is
allowed. Whitespace around the string is ignored. Anything else throws a
`TypeError` naming the input.
