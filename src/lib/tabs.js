import { MANAGEMENT } from './roles'

const STOCK_ROLES = ['storekeeper', 'manager', 'gm', 'admin']

// Each role's bottom bar — the ONE place it is defined.
//
// The bar, the More menu and the landing screen used to decide this
// separately: Shell built the bar, More excluded duplicates with a
// hand-written list per role, and App picked the landing tab by its own
// rules. Moving a tab onto a bar meant three coordinated edits, and when
// one was missed an item appeared twice (the auditor's Counts and
// Variances were in both the bar and More) or a badge pointed at a tab
// that no longer held the thing it counted.
//
// Now: the bar comes from here; More hides anything that is on the bar;
// and a role lands on its FIRST tab. Change a role's tabs here and all
// three follow.
export function tabsFor(role, { recordsSales = false } = {}) {
  if (role === 'manager') {
    // The manager runs the day. Daily sales first for the whole-branch
    // picture on arrival. Sales second: it opens on their default,
    // Reception, where the close of day and the room-charge approvals
    // box live — managers approve room charges, and previously had to go
    // More -> Sales -> Reception to see them. Then Rooms and Credit.
    // Counts stays in More: verifying adjusted counts is occasional, and
    // the pending badge still points them there.
    return [['dailysales', 'Daily sales'], ['sales', 'Sales'], ['roomboard', 'Rooms'],
            ['credit', 'Credit'], ['more', 'More']]
  }
  if (MANAGEMENT.includes(role)) {
    // GM and admin (managers are handled above): oversight of the whole
    // business across both branches. Daily sales first; Rooms and Credit;
    // then Variances — where counted stock and recorded sales disagree,
    // the most direct view of money going missing, which is the GM's to
    // watch. Sales (approvals, close of day) stays in More: front desk
    // and managers handle approvals day to day, the GM is the backstop.
    return [['dailysales', 'Daily sales'], ['roomboard', 'Rooms'], ['credit', 'Credit'],
            ['variance', 'Variances'], ['more', 'More']]
  }
  if (role === 'storekeeper') {
    // Receive and transfer, see what's on hand, count. Sales only if they
    // are assigned to a sales department.
    const t = [['store', 'Store'], ['stock', 'Stock'], ['count', 'Counts']]
    if (recordsSales) t.push(['sales', 'Sales'])
    return [...t, ['more', 'More']]
  }
  if (role === 'auditor') {
    // Ordered by the auditor's work: verify submitted counts (their one
    // sign-off, and where the alert points), investigate the variances
    // those counts reveal, review the day's sales, then History — every
    // edit and deletion at the branch, the evidence that shows tampering.
    // Stock moves to More, which auditors can now reach.
    return [['count', 'Counts'], ['variance', 'Variances'], ['dailysales', 'Daily sales'],
            ['fix', 'History'], ['more', 'More']]
  }
  const t = [['sales', 'Sales']]
  if (role === 'front_desk') t.push(['roomboard', 'Rooms'])
  if (STOCK_ROLES.includes(role)) t.push(['store', 'Store'])
  return [...t, ['stock', 'Stock'], ['more', 'More']]
}

// Where a role lands on sign-in: its first tab.
export const landingTabFor = (role) => tabsFor(role)[0][0]

// Which tab carries the "counts awaiting verification" badge: Counts if
// it's on this role's bar, otherwise More (where Counts then lives).
export const countBadgeTabFor = (role, opts) =>
  tabsFor(role, opts).some(([k]) => k === 'count') ? 'count' : 'more'
