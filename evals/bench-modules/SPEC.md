# SPEC: four utility modules

Four independent ES modules. Each lives in its own file under `src/`, exports exactly the names
below, and shares no code with the others. No dependencies: Node built-ins only. Tests use
`node:test` and `node:assert` and live in `test/<module>.test.mjs`.

## `src/duration.mjs`

`export function parseDuration(str)` returns the duration in milliseconds as an integer.

- The input is one or more `<digits><unit>` segments with nothing between them, for example
  `'1h30m15s'` (5415000), `'250ms'` (250), `'2d'` (172800000), `'1m30s500ms'` (90500).
- Units: `d` (86400000 ms), `h` (3600000), `m` (60000), `s` (1000), `ms` (1).
- Units appear in that order (`d` before `h` before `m` before `s` before `ms`), each at most once.
- Digits are ASCII `0`-`9` only: no sign, decimal point, exponent or separators. Leading zeros and
  zero values are allowed (`'0s'` is 0, `'05m'` is 300000).
- Leading and trailing whitespace is ignored; whitespace inside the string is not allowed.
- Throws `TypeError` when `str` is not a string.
- Throws `SyntaxError` for any other malformed input: empty or whitespace-only, a unit with no
  number (`'h'`), a number with no unit (`'10'`), an unknown unit (`'5w'`), units out of order
  (`'1s1m'`) or repeated (`'1m1m'`), signs, decimals, inner spaces, or upper-case units (`'1H'`).
- Throws `RangeError` when the result is greater than `Number.MAX_SAFE_INTEGER`.

## `src/semver.mjs`

`export function compare(a, b)` compares two version strings by
[SemVer 2.0.0](https://semver.org/spec/v2.0.0.html) precedence and returns `-1`, `0` or `1`.

- A version is `MAJOR.MINOR.PATCH`, optionally followed by `-PRERELEASE` and/or `+BUILD`.
- `MAJOR`, `MINOR`, `PATCH` are non-negative integers without leading zeros (`0` is fine, `01` is
  not). No `v` prefix, no surrounding whitespace.
- `PRERELEASE` and `BUILD` are non-empty dot-separated identifiers of `[0-9A-Za-z-]`, with no
  empty identifier. A numeric prerelease identifier must not have leading zeros (`1.0.0-01` is
  invalid); build identifiers may (`1.0.0+001` is valid).
- Precedence: compare major, minor, patch numerically. A version with a prerelease is lower than
  the same version without one. Prerelease identifiers compare left to right: numeric ones
  numerically, alphanumeric ones in ASCII order, numeric lower than alphanumeric, and when all
  shared identifiers are equal the longer list is greater. So
  `1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-alpha.beta < 1.0.0-beta < 1.0.0-beta.2 < 1.0.0-beta.11 <
  1.0.0-rc.1 < 1.0.0`.
- Build metadata is ignored: `compare('1.0.0+a', '1.0.0+b')` is `0`.
- Numbers may exceed `Number.MAX_SAFE_INTEGER` and must still compare exactly.
- Throws `TypeError` when either argument is not a string or not a valid version.

## `src/csv.mjs`

`export function parse(text)` parses CSV text (RFC 4180 style) into an array of rows, each an
array of field strings.

- Fields are separated by `,`. Records end with `\n` or `\r\n`; a lone `\r` is ordinary data.
- A field may be enclosed in double quotes. Inside quotes, `""` is one literal `"`, and `,`,
  `\r` and `\n` are literal characters.
- Nothing is trimmed: `' a , b '` is `[[' a ', ' b ']]`. Empty fields are kept: `'a,,b'` is
  `[['a', '', 'b']]`, `','` is `[['', '']]`, `'""'` is `[['']]`.
- `''` is `[]`. One final record terminator does not add a row (`'a\n'` is `[['a']]`), but an
  empty line elsewhere is a row with one empty field (`'a\n\nb'` is `[['a'], [''], ['b']]`).
- Rows may have different numbers of fields.
- Throws `SyntaxError` for an unterminated quoted field, a `"` inside an unquoted field
  (`'a"b'`), or anything other than `,` or a record end right after a closing quote (`'"a"b'`).
- Throws `TypeError` when `text` is not a string.

## `src/lru.mjs`

`export class LRUCache` is a least-recently-used cache.

- `new LRUCache(capacity)`: `capacity` must be a positive integer, else `RangeError`.
- `get(key)` returns the value, or `undefined` when absent, and marks the key most recently used.
- `set(key, value)` inserts or updates the value, marks the key most recently used and returns
  the cache. When an insert makes the size exceed the capacity, the least recently used entry is
  evicted.
- `has(key)` returns a boolean and does not change recency.
- `delete(key)` removes the key and returns whether it was present.
- `size` is a read-only getter with the number of entries.
- Keys are compared like `Map` keys (SameValueZero: `NaN` is a valid key, `0` and `-0` are the
  same key, objects by identity). `undefined` is a valid value: `has` tells it apart from absent.
