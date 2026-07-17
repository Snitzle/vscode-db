// Input parsing shared by the table grid and the query panel's editable
// results: turning what the user typed into the scalar the host should write.

// Typing now() into a temporal column inserts the current date/time in the
// format that column expects (DATE → date only, TIME → time only, otherwise
// a full datetime). Non-temporal columns keep the literal text. Returns
// undefined when the keyword does not apply.
export function expandNowKeyword(text, column) {
  const lowerType = (column && column.dataType ? column.dataType : '').toLowerCase();
  if (text.toLowerCase() !== 'now()' || !/(date|time|timestamp)/.test(lowerType)) {
    return undefined;
  }

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  // Plain DATE / TIME (with optional precision, e.g. time(3)) get just that
  // part; datetime/timestamp and anything else temporal get the full string.
  if (/^date(\(|$)/.test(lowerType)) {
    return date;
  }
  if (/^time(\(|$)/.test(lowerType)) {
    return time;
  }
  return `${date} ${time}`;
}

export function parseInputToScalar(rawInput, column) {
  if (rawInput === null || rawInput === undefined) {
    return null;
  }
  if (typeof rawInput !== 'string') {
    // Already a scalar (e.g. programmatic setValue) — nothing to parse.
    return rawInput;
  }

  const text = rawInput.trim();

  if (text.length === 0) {
    return column && column.nullable ? null : rawInput;
  }

  if (text.toUpperCase() === 'NULL') {
    return null;
  }

  const nowValue = expandNowKeyword(text, column);
  if (nowValue !== undefined) {
    return nowValue;
  }

  const lowerType = (column && column.dataType ? column.dataType : '').toLowerCase();
  if (/(int|decimal|numeric|real|float|double)/.test(lowerType)) {
    const num = Number(text);
    if (!Number.isNaN(num)) {
      return num;
    }
  }

  if (/(bool)/.test(lowerType)) {
    if (text === '1' || text.toLowerCase() === 'true') {
      return true;
    }
    if (text === '0' || text.toLowerCase() === 'false') {
      return false;
    }
  }

  return rawInput;
}

export function scalarEquals(a, b) {
  if (a === b) {
    return true;
  }

  return String(a) === String(b);
}
