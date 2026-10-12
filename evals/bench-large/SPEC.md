# SPEC: three parsers and evaluators

Three independent ES modules. Each lives in its own file under `src/`, exports exactly the names
below, and shares no code with the others. No dependencies: Node built-ins only. Tests use
`node:test` and `node:assert` and live in `test/<module>.test.mjs`. Where this spec names an
error type, throw exactly that built-in class; messages are free text.

## `src/cron.mjs`

`export function parse(expr)` parses a five-field cron expression and returns
`{ minute, hour, dayOfMonth, month, dayOfWeek }`, each an ascending array of the distinct
integers that field allows.

- Fields are separated by one or more spaces or tabs; leading and trailing whitespace is ignored.
- Bounds: `minute` 0-59, `hour` 0-23, `dayOfMonth` 1-31, `month` 1-12, `dayOfWeek` 0-6
  (0 is Sunday). In the day-of-week field `7` also means Sunday and is stored as 0, so `5-7` is
  `[0, 5, 6]`.
- A field is a comma-separated list of items with no spaces. An item is one of:
  - `*`: every value in bounds;
  - `V`: one value;
  - `A-B`: every value from `A` to `B` inclusive;
  - `*/S` or `A-B/S`: every `S`-th value of `*` or `A-B`, starting at its first value
    (`*/15` in the minute field is `[0, 15, 30, 45]`, `1-10/4` is `[1, 5, 9]`).
- `V`, `A`, `B` and `S` are ASCII digits. In the month field `V`, `A` and `B` may also be
  `JAN`-`DEC` (1-12), and in the day-of-week field `SUN`-`SAT` (0-6), in any letter case
  (`mon-Fri`). A step is always digits.
- The whole expression may instead be one macro, in lower case:
  `@yearly` and `@annually` (`0 0 1 1 *`), `@monthly` (`0 0 1 * *`), `@weekly` (`0 0 * * 0`),
  `@daily` and `@midnight` (`0 0 * * *`), `@hourly` (`0 * * * *`).
- Throws `TypeError` when `expr` is not a string.
- Throws `SyntaxError` when there are not exactly five fields, for an unknown macro (`@reboot`,
  `@DAILY`), an empty list item (`1,,2`, `1,`), or any item that is not one of the forms above
  (`5/15`, `1-`, `-1`, `1.5`, `**`, `*/`, `JANUARY`, a name in the wrong field).
- Throws `RangeError` when a value is outside the field's bounds (`60` minutes, day of month `0`,
  month `13`, day of week `8`), a range starts after it ends (`5-1`, `FRI-SUN`), or a step is 0.

`export function next(expr, from)` returns a new `Date`: the earliest whole minute (seconds and
milliseconds zero) strictly after `from` that matches `expr`, in UTC.

- A minute matches when its minute, hour and month are in the parsed sets and its day matches.
- If both the day-of-month and the day-of-week field (after macro expansion) are something other
  than `*`, a day matches when it is in either set (`0 0 13 * FRI` fires on every 13th and on
  every Friday). Otherwise a day must be in both sets (a `*` field allows every day).
- Returns `null` when nothing matches within 8 years after `from` (`0 0 30 2 *`). Must answer in
  well under a second even then.
- Throws as `parse` does for a bad `expr`, and `TypeError` when `from` is not a `Date` or is an
  invalid date. Never modifies `from`.

## `src/schema.mjs`

`export function validate(value, schema)` validates a JSON value against a subset of JSON Schema
(draft-07) and returns an array of `{ path, keyword, message }` errors, empty when the value is
valid. The order of errors is unspecified.

- `path` is a JSON Pointer to the failing value: `''` for the root, `/address/street`, `/tags/0`.
  In each key `~` is written `~0` and `/` is written `~1`.
- `keyword` is the schema keyword that failed (`'type'`, `'required'`, ...) and `message` is a
  non-empty human-readable string.
- A schema is a plain object (not an array or `null`) or a boolean. `true` accepts everything;
  `false` rejects everything with one error with keyword `'false'`. Throws `TypeError` when a
  schema (the root or any nested one that is reached) is neither. Unknown keywords are ignored.
- Every applicable keyword is checked; one failing does not stop the others. Keywords for one JSON
  type are ignored for values of other types (`minLength` on a number passes).

Keywords:

- `type`: one name or an array of names among `null`, `boolean`, `object` (not arrays, not
  `null`), `array`, `number`, `integer` (a number with no fractional part, so `1.0` is one) and
  `string`. One error when the value matches none.
- `enum` (an array) and `const`: the value must deeply equal one element / the constant. Deep
  equality is JSON equality: same type, arrays element by element, objects with the same keys in
  any order. One error each.
- `required`: for objects, one error per missing property name, at the object's path.
- `properties`: for objects, each present property listed is validated against its schema at
  `<path>/<key>`.
- `additionalProperties`: for objects, each property not listed in `properties` is validated
  against this schema. When it is `false`, that is one error per extra property, at the object's
  path, with keyword `'additionalProperties'`; when it is a schema, its errors are reported at
  `<path>/<key>`.
- `items` (one schema): for arrays, each element is validated at `<path>/<index>`.
- `minLength` / `maxLength`: string length in Unicode code points, inclusive (`'😀'` is 1).
- `minItems` / `maxItems`: array length, inclusive.
- `minimum` / `maximum`: for numbers, inclusive.
- `pattern`: for strings, the value must contain a match of `new RegExp(pattern, 'u')`
  (unanchored).
- `allOf`: the value is validated against each subschema and all their errors are reported.
- `anyOf`: when no subschema accepts the value, one error with keyword `'anyOf'` at the value's
  path (the subschemas' own errors are not reported).
- `oneOf`: when not exactly one subschema accepts the value, one error with keyword `'oneOf'` at
  the value's path.
- `$ref`: `'#/definitions/<name>'` refers to `definitions[name]` of the root schema. When `$ref`
  is present, every other keyword in that schema is ignored. Recursive references (a tree whose
  `children` items refer back to the same definition) must work. Throws `ReferenceError` for any
  `$ref` that does not resolve this way, when it is reached.

## `src/expr.mjs`

`export function evaluate(src, vars = {})` parses and evaluates an expression and returns its
value, a number or a boolean.

Tokens, separated by optional whitespace (spaces, tabs, newlines):

- numbers: the longest match of `/\d+(\.\d+)?([eE][+-]?\d+)?/` (so `.5` and `1.` are errors);
- `true`, `false`;
- identifiers: `/[A-Za-z_][A-Za-z0-9_]*/`, a function call when followed by `(`, else a variable;
- operators and punctuation: `( ) , ? : || && == != < <= > >= + - * / % ! ^`.

Precedence, lowest first:

| Level | Operators | Associativity |
|---|---|---|
| 1 | `c ? a : b` | right |
| 2 | `\|\|` | left |
| 3 | `&&` | left |
| 4 | `==` `!=` | left |
| 5 | `<` `<=` `>` `>=` | left |
| 6 | `+` `-` | left |
| 7 | `*` `/` `%` | left |
| 8 | prefix `-` `!` | right |
| 9 | `^` (power) | right |

`^` binds tighter than a prefix operator on its left and its right operand may itself start with
a prefix operator: `-2 ^ 2` is `-4`, `2 ^ -1` is `0.5`, `2 ^ 3 ^ 2` is `512`.

Values and types:

- Numbers are JavaScript numbers. `+ - * / % ^ < <= > >=` and prefix `-` take numbers; `/` and
  `%` follow JavaScript (`%` keeps the dividend's sign). `&& || !` and the condition of `?:` take
  booleans; `== !=` take two numbers or two booleans. Any other operand type is a `TypeError`, so
  `1 < 2 < 3` is a `TypeError` (`true < 3`).
- `&&`, `||` and `?:` short-circuit: the operand not needed is not evaluated, so
  `false && missing` is `false` and `true ? 1 : 1 / 0` is `1`.
- `/` or `%` by zero throws `RangeError`.
- A variable is an own property of `vars` (inherited ones such as `toString` do not count) whose
  value is a finite number or a boolean. Throws `ReferenceError` for an unknown variable and
  `TypeError` for a value of another type.
- Functions: `abs(x)`, `floor(x)`, `ceil(x)`, `sqrt(x)` (`RangeError` for a negative `x`),
  `round(x)` (halves round away from zero: `round(2.5)` is `3`, `round(-2.5)` is `-3`),
  `min(x, ...)` and `max(x, ...)` (one or more arguments). Arguments must be numbers
  (`TypeError`). A wrong number of arguments is a `TypeError`; an unknown function (including
  inherited names such as `toString`) is a `ReferenceError`.

Errors:

- Throws `TypeError` when `src` is not a string or `vars` is not a non-null object.
- Throws `SyntaxError` for any input that is not one complete expression, with an integer
  `position` property. If `src` cannot be split into tokens, it is the index of the first place
  where no token can be read (`=` alone and `&` alone are not tokens); otherwise it is the
  0-based index of the start of the first unexpected token, or `src.length` when the input ends
  too early. Examples: `''` → 0, `'1 +'` → 3, `'(1'` → 2, `'1 2'` → 2, `')'` → 0, `'1 # 2'` → 2,
  `'1 = 2'` → 2, `'max(1,)'` → 6, `'1.'` → 1, `'1 2 #'` → 4.
