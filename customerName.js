// Single source of truth for customer-name normalization, mirrored
// exactly from normalize_customer_name() in the database. Keep the
// two in sync — the app uses this for the duplicate-warning hint and
// for recovering from a unique-constraint conflict; if it drifts from
// the database version, that recovery can miss and surface a raw
// error mid-sale instead of quietly reusing the right customer.
export function normalizeCustomerName(s) {
  return (s || '').toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/\b(c\/o|c\.o\.|care of)\b.*$/, ' ')
    .replace(/\b(mr|mister|mrs|missus|miss|ms|dr|doctor|chief|engr|engineer|alhaji|alhaja|pastor|rev|reverend|prof|professor|sir|madam|mallam|barr|barrister|oga|bros|brother|sister|aunty|uncle)\b\.?/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
