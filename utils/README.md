# Date Utilities (`utils/date-utils.js`)

A lightweight, zero-dependency date utility module built with Node.js.

## Functions

### `getCurrentDate()`
Returns the current local date formatted as `YYYY-MM-DD`.

- **Returns**: `string` - Formatted date string (e.g., `2026-11-01`).

### `formatDate(date)`
Formats a valid `Date` instance, ISO date string, or timestamp into `DD-MM-YYYY`.

- **Parameters**: `date` (`Date | string | number`) - The date to format.
- **Returns**: `string` - Formatted date string (e.g., `01-11-2026`).
- **Throws**: `TypeError` if `date` is invalid or empty.

### `isValidDate(date)`
Validates whether the provided value represents a valid date.

- **Parameters**: `date` (`any`) - Input to check.
- **Returns**: `boolean` - `true` if valid, otherwise `false`.

## Running Tests

Run the built-in Node.js test runner:

```bash
node --test utils/date-utils.test.js
```
