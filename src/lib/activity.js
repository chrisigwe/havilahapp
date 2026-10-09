import { supabase } from './supabase'

// Records, for the GM's "Staff activity" screen, which page someone opened or
// which key thing they did. Only a short label is sent - never amounts, names
// or anything typed. Fire-and-forget: it can never slow down or break the work
// it describes, and failures (offline, old database) are silently ignored.
export function logActivity(kind, name) {
  try {
    Promise.resolve(supabase.rpc('log_activity', { p_kind: kind, p_name: name })).catch(() => {})
  } catch { /* ignore */ }
}

// Wraps a save so that, once it SUCCEEDS, the action is logged. Behaviour and
// return value of the save are unchanged.
export const tracked = (label, fn) => async (...args) => {
  const out = await fn(...args)
  logActivity('action', label)
  return out
}

export const PAGE_NAMES = {
  sales: 'Sales', store: 'Store', stock: 'Stock', more: 'More menu',
  dailysales: 'Daily sales', roomboard: 'Rooms', staysettings: 'Settings',
  catalog: 'Catalog', payroll: 'Payroll', staffaccounts: 'Staff accounts',
  mypay: 'My pay', tillchecks: 'Total Sales checks', variance: 'Variances',
  recovery: 'Recovered debt', credit: 'Credit', count: 'Stock count',
  fix: 'Corrections', activity: 'Staff activity', attendance: 'Attendance',
}
