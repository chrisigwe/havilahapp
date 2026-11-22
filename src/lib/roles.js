// Role groups — the ONE place that says who counts as what.
//
// Before this file, the same sets were typed inline 21 times across
// 11 files in five different combinations. Changing who counts as a
// supervisor meant finding every copy, and asking "which roles get
// alerts?" meant grepping. Each group below mirrors a rule the
// DATABASE already enforces where one exists, so the app and the RLS
// policies cannot quietly drift apart.
//
// Membership here is exactly what was inline before. This file changed
// no one's access — it only names what was already there.

// gm, admin. Mirrors is_supervisor() in the database.
// Deletes, merges, overrides, Staff of the Month, internal rooms.
export const SUPERVISOR = ['gm', 'admin']

// manager, gm, admin. Mirrors can_manage_rooms() in the database.
// Room management, out-of-service, stay settings.
export const MANAGEMENT = ['manager', 'gm', 'admin']

// storekeeper, manager, gm, admin. Can edit and override entries.
export const EDITOR = ['storekeeper', 'manager', 'gm', 'admin']

// storekeeper, manager, gm, admin, auditor. Read access across the
// whole branch: every department, stay times, verification alerts.
export const OVERSIGHT = ['storekeeper', 'manager', 'gm', 'admin', 'auditor']

// front_desk, gm, admin. Correcting guest identity records — the
// people who take bookings, plus supervisors.
export const RECEPTION_EDIT = ['front_desk', 'gm', 'admin']

export const is = (role, group) => group.includes(role)

// front_desk, manager, gm, admin. Approve or refuse large room charges.
// Mirrors approve_room_charge() / reject_room_charge() in the database
// (migration 250) exactly, so the controls never appear to someone the
// database would refuse.
export const APPROVE_ROOM_CHARGES = ['front_desk', 'manager', 'gm', 'admin']

// manager, gm, admin, auditor. Who may send the credit watch out of the
// app — to the bar's phone, or to print and stick up (Chris, 16
// November 2026).
//
// Bar staff READ the watch; that is the whole point of showing it where
// they key. They do not circulate it. A list of who owes what, sent on
// from a barman's phone, is a different document from the same list
// posted behind the bar by a manager.
export const SENDS_CREDIT_WATCH = ['manager', 'gm', 'admin', 'auditor']

// auditor, manager, storekeeper, gm, admin. Open Credit and Recovered
// debt on ALL departments: their job is the whole branch, and a single
// department would quietly narrow the review. Everyone else opens on
// their own department.
//
// Manager and storekeeper joined on 22 November 2026 (Chris). They were
// already oversight everywhere else on those two pages -- they get the
// by-month view, which is the branch-wide rollup -- but opened scoped to
// one department, so they were handed a branch summary with most of the
// branch missing. Worse, neither usually HAS a department: startingDept
// falls through to the first sales point in the list, so a store manager
// was landing on whichever counter sorts first, with nothing on screen
// to say the choice was arbitrary.
export const OPENS_ON_ALL = ['auditor', 'manager', 'storekeeper', 'gm', 'admin']

// auditor, gm, admin. Deliberately NOT the list above, though Stock once
// shared it. Stock is a page people WORK on -- where is my stock, what
// came in -- and a storekeeper opening on her Store rather than the
// whole branch is the behaviour she is used to. Credit and Recovered are
// pages people REVIEW on, which is why the two lists part company.
export const STOCK_OPENS_ON_ALL = ['auditor', 'gm', 'admin']
