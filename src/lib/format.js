export const naira = (n) =>
  '₦' + Number(n ?? 0).toLocaleString('en-NG', { maximumFractionDigits: 2 })

// business date in Africa/Lagos regardless of device timezone
export const lagosToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(new Date())

export const tierLabel = { general: 'Standard', lounge: 'Lounge', staff: 'Staff' }
export const methodLabel = { pos: 'POS', cash: 'Cash', credit: 'Credit', transfer: 'Transfer' }

// N days before the Lagos business date — matches lagos_today() - N in
// the database exactly, so app-side windows never disagree with what
// RLS actually permits.
export const lagosDaysAgo = (n) => {
  const d = new Date(lagosToday() + 'T12:00:00')
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

// Who a sale is attributed to for display: the person it was
// recorded on behalf of, if any, with a note on who actually typed
// it — otherwise just whoever entered it themselves. One shared
// definition so the Sales list and Daily Sales history can't drift
// apart on this.
export const whoRecorded = (r) =>
  r.stood_in_for?.full_name
    ? `${r.stood_in_for.full_name} (recorded by ${r.recorder?.full_name || 'unknown'})`
    : (r.recorder?.full_name || 'unknown')
