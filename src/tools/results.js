/** Result sizing shared by tools that return lists. */

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 200;

/** JSON Schema for the `limit` argument. */
export const LIMIT_SCHEMA = Object.freeze({
  type: 'integer',
  minimum: 1,
  maximum: MAX_LIMIT,
  description: `Most rows to return (default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT}).`,
});

/** Keep the first `limit` rows and report how many matched in total. */
export function capRows(rows, limit = DEFAULT_LIMIT) {
  const kept = rows.slice(0, Math.min(limit, MAX_LIMIT));
  return {
    total: rows.length,
    returned: kept.length,
    truncated: kept.length < rows.length,
    rows: kept,
  };
}

/** Format an epoch millisecond time as ISO 8601, or null. */
export function isoTime(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** "1 earthquake", "3 earthquakes". */
export function countNoun(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}
