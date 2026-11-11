// Which day the Sales screen opens on (Chris, 11 November 2026).
//
// Kept apart and import-free so the rule that decides WHICH DAY a sale
// lands on can be read in full and proved. A wrong day puts a night's
// takings on the wrong page of the book, so this is not a detail.
//
// The problem: OpenBar records after service and the Restaurant records
// the next day, so in the morning those two are working on YESTERDAY.
// Opening on today meant changing the date on nearly every basket, and
// sometimes forgetting. Thirty days counted on 18 October: 1,568 sales
// keyed the day after the one they belong to against 332 the same day,
// over half between 09:00 and 11:00.
//
//   recordsAfterService - the department's own flag (migration 730)
//   hour                - the hour in Lagos, 0-23
//   yesterdayChecked    - has this department entered yesterday's Total Sales
//   current             - the date the screen is showing now
//
// Returns the date to open on.
export function dayToOpenOn({ recordsAfterService, hour, yesterdayChecked, today, yesterday, current }) {
  // The person has already chosen a day. Never argue with them.
  if (current && current !== today) return current
  // Minimart, MainBar and Reception record as they sell. Today is right.
  if (!recordsAfterService) return today
  // After midday the night is long over, and the Restaurant - which does
  // no Total Sales check - must not sit on yesterday all evening.
  if (!(hour >= 0 && hour < 12)) return today
  // Yesterday closed means yesterday is finished.
  if (yesterdayChecked) return today
  return yesterday
}
