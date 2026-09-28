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
