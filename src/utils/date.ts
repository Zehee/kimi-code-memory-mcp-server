/**
 * Shared date-boundary helpers for SQL queries.
 */

export interface DateRange {
  from?: string;
  to?: string;
}

/**
 * Convert optional YYYY-MM-DD date strings into inclusive ISO date boundaries.
 */
export function dateRangeSql(dateFrom?: string, dateTo?: string): DateRange {
  return {
    from: dateFrom ? `${dateFrom}T00:00:00.000Z` : undefined,
    to: dateTo ? `${dateTo}T23:59:59.999Z` : undefined,
  };
}
