# Havilah Inventory

Mobile-first inventory & bar sales app for Havilah Suite Ltd (Awka & Nnewi).
Shares the Supabase project with the front desk register: same staff, same
branches, one stock ledger.

## Setup

1. Run `10_auth_rls.sql` in the Supabase SQL Editor (once).
2. Create logins: Supabase Dashboard → Authentication → Add user
   (email + password; emails like `chidi.openbar@havilah.local` are fine).
3. Link each login to its staff row — template at the bottom of `10_auth_rls.sql`
   (sets `auth_user_id` and the barman's `default_location_id`).
4. `cp .env.example .env` and fill in the project URL + anon key
   (Dashboard → Settings → API).
5. `npm install && npm run dev`

## Deploy (Netlify)

Push to GitHub → import in Netlify → add the two `VITE_` environment
variables → deploy. `netlify.toml` handles the SPA redirect.

## How it behaves

- Barman signs in, lands on Sales with their bar preselected.
- "Record a sale": search item (most-sold first, live stock shown),
  qty stepper, tier + payment chips, optional split; price is editable
  because real prices sometimes deviate from catalog.
- PR / damaged are write-offs (stock_movements), never sales rows.
- Every saved sale writes its own stock deduction via the DB trigger —
  the app never computes stock, it only reads `v_stock_on_hand`.
- Stock tab: on-hand by location, negatives in red (they mean a count
  or a missed entry is needed).
- Store tab (storekeeper / manager / gm / admin only): Receive records
  deliveries into the store with unit cost; Disburse moves stock from
  the store to a department. Several items are staged and saved in one
  go, and Disburse warns when a line exceeds what the store holds.

- Fix tab (manager / gm / admin only): last 14 days of sales and stock
  movements, each editable (quantity, price/cost) or deletable. Deleting
  a sale reverses its stock deduction automatically; editing one restates
  its payment record to the new total. Sale deductions are hidden from
  the list — correct the sale itself and the movement follows.
  A second view, Change history, shows every deletion and edit with
  who did it and when. That log is written by database triggers
  (15_audit_log.sql), so corrections made outside the app are recorded
  too. It is append-only: nobody can edit or delete the log itself.
  Storekeepers have the same Fix tab as managers (18_storekeeper_full_rights.sql).

## Branch scope

Only GM and admin see both branches (21_branch_scope.sql). They get a
branch selector in the header; switching reloads the whole app against
that branch, so every screen — sales, stock, credit, counts, corrections
— shows the selected branch. They can also record in either branch
(26_admin_cross_branch_write.sql). Everyone else has no selector and is
pinned to their own branch by RLS regardless of what the client asks for. Managers,
store managers, auditors and bar staff are confined to their own branch —
they keep every capability their role carries, but only within it.
Someone who works both branches needs one account per branch.

- Credit tab: outstanding balances per customer, a full statement
  (credit taken, payments received, balance) and Record payment for
  recovery by POS/cash/transfer. Print / PDF uses the browser's print
  dialog — "Save as PDF" produces the invoice.
- Count tab: the store manager starts a count for a location, enters
  physical quantities against what the system says, and submits it.
  An auditor then verifies, and any variance posts automatically as
  an adjustment so the ledger matches the shelf. Only an auditor can
  verify — enforced by verify_stock_count(), not the UI.

## Kitchen, Housekeeping and Others

These are consuming departments (`consumes_on_issue`). Stock disbursed
to them is expensed on issue: it leaves the store and does not build up
as a balance there. Consumption stays attributed to the department for
reporting via `v_consumption`. They are not sales points, so they never
appear on the Sales screen — kitchen staff can be given their own sales
point later by flipping `is_sales_point`.

## Who sees what

`staff_locations` assigns each person their departments (14_staff_locations.sql).
Barmen see only their own areas on both the Sales and Stock tabs.
Storekeepers, managers, GM and admin see every location — as does
anyone with no assignment yet, so nobody is locked out by omission.

At Nnewi, OpenBar staff are assigned OpenBar *and* Lounge, since
Lounge is a location there. At Awka, Lounge is a price tier, so
OpenBar staff reach it through the tier chips instead.

## Who can do what

Location is never locked: `default_location_id` only preselects a
staff member's usual bar, and anyone can switch. Awka's OpenBar staff
ring up Lounge-priced sales via the tier chips on the same screen.
Recording is open to all active staff for their own branch; editing
and deleting history stay manager-only (enforced by RLS, not the UI).


## Offline behaviour

Writes that fail because the connection dropped are kept in
localStorage and retried automatically when it returns (`src/lib/outbox.js`).
A banner shows how many entries are waiting. Only connection errors are
queued — a real rejection (bad data, a permission error) surfaces to the
user immediately instead of being silently swallowed.

## Sales are recorded as a basket

Add several items, adjust tier and price per line, then take payment once.
The payment split is allocated across the lines automatically. Overdrawing
a location asks for confirmation rather than blocking.

## Backups

See BACKUP.md.


## Sales reporting model (change request section 4)

Gross Sales and money collected are separate figures and are never
summed together:

    Gross Sales      = sum(qty x unit price)      -- goods off the shelf
    Received at sale = POS + Cash on those sales
    Credit raised    = Gross Sales - Received     -- derived, not typed
    Debt recovered   = repayments received today against earlier credit
    Total money in   = Received + Debt recovered

Debt recovery never increases Gross Sales. The panel on the Sales
screen shows all five, per location per day, for checking against the
Book of Records. Views: `v_reconciliation`, `v_debt_recovered_daily`.

## Backdating

The date on a sale defaults to today. Bar staff can post up to 4 days
back; store manager, manager, GM and admin reach the opening-balance
date (31_staff_backdate_window.sql). Future dates are refused for
everyone. All three rules live in `validate_sale_date()`, not the UI —
change `window_days` there to adjust the staff window.

Note the interaction with corrections: bar staff can only edit their own
entries from today and yesterday, so a sale they backdate further than
that cannot afterwards be corrected by them — it needs a store manager. Backdated rows carry an optional reason
and show a "backdated" marker. All reporting keys off `business_date`.

## Opening balances

More > Stock count > Opening balance: pick a location and date, enter
counted quantities, post. Writes adjustment movements for
(counted - system) and sets the branch's opening-balance date, which
then bounds backdating. Manager-only, and deliberately skips the
auditor step — every such posting is written to the audit log saying so.

## Variances

More > Variances lists any sale where POS + Cash + Credit does not equal
quantity x unit price, with operator and amount (`v_sale_variances`).
Bar staff cannot save an unbalanced sale at all; managers can override
with a confirmation, and the override lands here.


## One customer, one record

Customer names are normalised in the database (`normalize_customer_name`):
titles, bracketed asides, "c/o ..." attributions and punctuation are
stripped, so "Mr Chike", "Mr. Chike", "Mr Chike c/o Kelvin" and
"Mr Chike (Caleb)" all reduce to the key `chike`. A unique index on
(branch_id, name_key) means a second record cannot be created for the
same person, and the app reuses the existing one if a barman types a
different spelling.

Who served the customer goes in `served_by`, not in the name.
`v_customer_similar` lists near-matches the key cannot catch (a surname
added later, a typo); `merge_customers(keep, merge[])` folds them
together, moving sales and repayments to the surviving record.

Catalog editing is GM and admin only, enforced by RLS.


## Receipts

Every basket is stamped with a `receipt_id`, so its lines can be pulled
back together and printed as one document however it was paid — POS,
cash, credit or a split. The receipt shows department, item, tier, qty,
unit price and amount, then a payment table naming each method and its
amount; a credit portion is labelled as outstanding. Customer is optional
on cash and POS sales (blank prints as "Walk-in") and required for credit.

Reprint from the Sales screen: tap any row under Today, or use "Receipt
for the last sale" straight after saving. `27_receipts.sql` also groups
existing app-entered sales into receipts so older sales can be printed.


## Credit is per department

OpenBar's debtors are not MainBar's. A customer is still one record
(so a name is never split in two), but credit taken and repayments are
tracked per location: `v_customer_balances_by_location`, and
`credit_repayments.location_id`. The Credit tab has department chips,
each showing only what is owed to that department, and a statement
prints with the department in its header.

A repayment always belongs to the department whose credit it settles —
paying at OpenBar does not clear a MainBar debt.

## Staff fixing their own mistakes

Bar staff get More > Corrections showing only entries they themselves
recorded, from today and yesterday. They can edit quantity, price and
payment split — they cannot delete anything (29_staff_no_delete.sql).
Removing a record is store manager, manager, GM or admin only. The edit
window is enforced by `app_owns_recent()` in RLS, so it cannot be
widened from the client. They cannot see the change
history, and anything they alter is written to it under their name.
Backdating remains editor-only.


## Records are private to the person who recorded them

Bar staff see only their own sales and only the credit owed to them
(32_per_staff_records.sql). Joseph cannot see Ikenna's debtors even
though both work Open Bar. Store manager, manager, GM and admin see
everything for the branch and can filter the Credit tab by person.

Customer NAMES remain readable branch-wide — without that, a second
staff member typing an existing customer would hit the unique index and
the sale would fail. Names are shared; balances and statements are not.

`credit_repayments.credit_staff_id` records whose ledger a payment
settles, which is not always who collected it: a store manager taking
money for Joseph's debtor credits Joseph's ledger.

## Price tiers

The tier buttons sit above "+ Sell Item" — Standard / Lounge / Staff at
Awka, Standard / Lounge at Nnewi, driven by `branch_price_tiers`. Pick
the tier first and everything added is priced at it; switching mid-basket
reprices what is already there. A single line can still be overridden by
tapping it. The tier resets to Standard after each sale so the next
customer is not mispriced, and non-standard tiers are shown in amber on
the basket line and on the receipt.


## Bug fixes (round 2 audit)

- Write-offs (PR, damage) are now editor-only both in the UI and in
  RLS (34_writeoff_lockdown.sql) — a bar account cannot post one even
  through the API. The old always-visible "PR/damage" shortcut inside
  the item picker is removed; the single gated button above Sell Item
  is now the only entry point.
- PR/damage on the Sales panel is scoped to the department being
  viewed, same as every other figure there (`v_daily_non_revenue`
  gained `location_id`).
- Switching the basket's price tier no longer overwrites a line whose
  price was hand-edited; those lines carry `priceOverridden` and can be
  reset back to the tier price explicitly.
- A write-off now has its own date field (defaults to the sale date)
  instead of silently inheriting whatever the basket was set to.
- The receipt and the credit statement no longer share a print target
  id — each prints independently even if both could ever be open.


## Verification pass fixes

Checking every requirement against the deployed source turned up bugs
the earlier rounds missed:

- **The repayment/debt-recovery bug was still live in the app**, despite
  the database fix in 33. The "Record payment" button never attached a
  department or staff to the payment (`location_id` was always saved as
  null), so a saved payment could never match the department-filtered
  balance it was meant to reduce — the debt kept showing as unpaid. Fixed
  in `Credit.jsx`; also fixed the payment sheet showing "Owing ₦0" on
  every payment regardless of the real balance, for the same reason.
- PR/damage on the Sales panel was still branch-wide because the query
  fetched the old column shape after `v_daily_non_revenue` gained
  `location_id` — it was never updated to request or filter on it.
- Sales recorded "on behalf of" a staff member reached their credit
  ledger (via the balance view) but not their own Corrections list or
  an individually-opened ledger, because those two raw queries matched
  only `recorded_by`, never `on_behalf_of`. Fixed to match either.
- Since on-behalf-of sales now appear on the recipient's own list, the
  Edit button is hidden on entries they did not personally type — RLS
  only lets the actual recorder amend a sale, so showing an Edit button
  there would have failed silently. A note explains why instead.


## Fresh-start scoping (round 3 audit)

- Variances now respect a branch's `opening_balance_date` at the
  database level (`v_sale_variances`, 38_variances_respect_opening_date.sql)
  — the same rule backdating already followed. Nothing is deleted;
  pre-reset variances simply stop being reported once a branch has
  moved past them with a fresh start. Applies to any branch that ever
  gets reset this way, not just today's.
- The customer-name normalizer existed as two separate JS copies, and
  both had drifted out of sync with the database function after an
  earlier live update (added "doctor", "oga", "aunty", and others).
  One copy only weakened a UI hint; the other sat in the
  duplicate-conflict recovery path in `createCustomer` — a mismatch
  there could make the recovery miss the existing customer and surface
  a raw database error mid-sale instead of quietly reusing the right
  record. Unified into `src/lib/customerName.js`, one function, used
  everywhere, so this can't drift again.
- Removed a dead, unused `startCount` function left over from an
  earlier round.


## Final sweep (round 4)

- **Silent count-line save failures, now fixed.** A dropped connection
  while entering a stock count updated the number on screen but failed
  the actual save with only a `console.error` — no toast, nothing to
  tell the person their entry hadn't landed. A count could be submitted
  looking complete while some lines were silently still null, producing
  wrong variance postings with no warning. Count-line saves now surface
  a clear error, or queue through the offline outbox and retry
  automatically — same mechanism already proven for sales.
- **Credit repayments now go through the offline outbox too** — the same
  real-world conditions as a sale (weak signal at the counter) could
  previously fail a payment with no retry.
- **Fixed a timezone bug in "own recent entries."** The bar-staff
  edit window was computed from raw UTC time instead of the Lagos
  business date, so near midnight it could show a third day of entries
  whose Edit button would predictably fail against the database's
  correctly-timezoned boundary. Both now compute the same way
  (`lagosDaysAgo()`), and the Edit button itself checks the date, not
  just who recorded the entry, so it never appears where it can't work.
- Confirmed clean: no dangling references to removed features (the old
  picker write-off shortcut, the shared print-target id), all six roles
  consistently gated across every screen, and the auditor's two-tab
  view (Stock, Count only) holds together correctly end to end.
- **Known, deliberate gap:** the 4-day staff backdating limit is a
  constant in both the database function and the React component
  (`STAFF_BACKDATE_DAYS`). The database is the real enforcement, so a
  mismatch could only ever show the wrong number in the UI, never
  permit an out-of-bounds post — left as two constants rather than
  adding a settings lookup for one cosmetic value, but worth knowing
  if that limit is ever changed.


## On-behalf-of is now location-scoped

The "recording on behalf of" list on the Sales screen now shows only
staff assigned to the currently-selected location — Open Bar shows its
own people, MainBar its own, Minimart its own — instead of every bar
hand at the branch. It also includes front desk staff, who record
Minimart sales (see below). Switching locations reloads the list and
drops a stale selection if that person doesn't work the new location.

Front desk staff can now record sales here (39_front_desk_minimart.sql)
— same rights as bar staff: record for their assigned location, edit
their own entries today/yesterday, never delete. This is new capability
inside the inventory app only; nothing about their innflow access changes.

**One thing to decide, not assumed:** the two existing Front Desk
accounts are shared logins (one per branch, from the original
migration). Daniel/Mercy and Princess/Chidimma could share those, or
each get an individual login — the file includes both paths. Individual
logins match how every other credit/sales attribution in this app
works (`recorded_by`, `credit_staff_id`), so that's the recommended one
unless there's a reason to keep it shared.


## Catalog: full visibility and safe delete

The Catalog screen now fetches all items — active and inactive — for
itself (`loadAllCatalogItems`), separate from `boot.items` (which stays
active-only everywhere else, so pickers are unaffected). Active /
Inactive / All filter chips let an admin find and reactivate something
previously deactivated, which was impossible before.

Delete is real but guarded: `delete_stock_item()` (43_catalog_delete.sql)
refuses to remove anything with a single sale, movement, or count line
against it, anywhere, ever — the error names exactly how many of each it
found. Only a genuinely unused item (created by mistake, or a stray
duplicate never actually transacted against) can be hard-deleted.
Everything else stays on the "deactivate" path that already existed,
which hides an item everywhere without touching its history.


## Search and department filter on Corrections

The Corrections screen now has a search box (item name, department, or
a date in YYYY-MM-DD) and, on the Entries view, department chips —
matching the same pattern used on Sales and Store. Department is
resolved per entry regardless of type: a sale's own location, or a
movement's destination (falling back to its source for things leaving
a location, like an issue or disbursement).

Search also works on Change History, matching against the stored
summary text and date, since that view has no structured location
field of its own — the summary text already names the department, so
a search for "MainBar" still finds it.


## Deleting a customer

GM and admin only see a "Delete customer" button on a customer's
statement — narrower than the general edit right on the Credit page,
which also covers storekeepers. Same safety rule as catalog items:
`delete_customer()` (46_credit_customer_delete.sql) refuses to remove
anyone with a single sale or repayment against them, ever, and names
the counts in its error. The confirmation dialog offers "Deactivate
instead" right there for that common case — it hides the customer from
future credit sales without touching their history, reusing the
existing `customers.is_active` flag.


## Issue history per department

Under "+ Issue To" on the Store screen (Issue/OUT mode), a collapsible
"History — <Department>" section shows everything issued to whichever
department is currently selected: item, quantity, date, who received
it, and who issued it. Switching the department chip switches the
history shown — it follows whichever department you've selected, same
as the item picker and receiver field do. Covers the last 60 days.
No database changes — reads the same `stock_movements` rows already
written by every issue.


## Structural sweep (round 5)

Cross-checked the entire app against every migration file rather than
a single feature:

- Every RPC the app calls (`submit_stock_count`, `post_opening_balance`,
  `verify_stock_count`, `delete_stock_item`, `delete_customer`) is
  defined exactly once, matching what's called.
- Every view and helper function the app or RLS depends on exists,
  and where one was redefined across rounds (e.g. `app_branch`,
  `v_reconciliation`), the later version is a proper superset —
  nothing that an earlier round relied on silently disappeared.
- Every RLS policy that was ever dropped was recreated at least as
  many times as it was dropped — no silent lockouts. Every table with
  RLS enabled has a working read policy.
- Every column the app writes to has a matching migration that
  created it — no client code pointing at a column that was never
  actually added.
- Removed two dead functions: `saveSale` (replaced by `saveBasket`
  when checkout became a basket, never deleted) and
  `loadReceiptsForDate` (built for a receipt-listing feature that
  ended up implemented a different way — tapping a row directly, or
  "receipt for the last sale" — and was never wired in). Zero
  behavior change; the build output was byte-identical, confirming
  neither was ever actually reachable.
- Added `MIGRATIONS.md` — with 47 files and several explicitly
  superseding earlier ones, there was no single answer to "which
  files do I actually run if I ever rebuild this." Now there is.


## Crash reported: "TypeError: n is not a function" while switching branches on Catalog

Root cause not conclusively identified from a minified stack trace
alone (no sourcemap in production, and the trace pointed into React's
internal scheduler rather than app code directly) — but two real gaps
were closed regardless of the exact cause:

- **No crash safety net existed anywhere.** Any unhandled error in any
  screen unmounted the whole app to a blank white screen with nothing
  but a console log — exactly what was reported. Added
  `ErrorBoundary` wrapping the whole app: a crash now shows a plain
  "Something went wrong — Reload" message instead of nothing.
- **Catalog didn't reset its own state on a branch switch.** Since the
  GM/admin branch selector re-renders the current screen with new data
  rather than remounting it, an open edit sheet, a delete confirmation,
  or a half-filled "add item" form could keep referencing the
  *previous* branch's item after switching. Catalog now explicitly
  clears all of that the moment `staff.branch_id` changes, so switching
  branches can never leave stale state behind to act on incorrectly.

If this recurs, the browser console's full stack trace (all frames,
via "Copy stack trace" in DevTools) would let it be pinned down
precisely — the pasted trace here was already truncated to minified
function names with no line mapping.


## Source maps enabled

`vite.config.js` now builds with `sourcemap: true`. Without this, any
production crash only ever showed minified names ("n is not a
function", "at el", "at ns") with no way to trace them back to real
source — which is why the branch-switch crash took multiple rounds to
even attempt to localize. With the map file deployed alongside the JS
bundle, the browser decodes a crash automatically: the same error will
show the real file and line number directly in DevTools, no extra step
needed to reproduce it.

The map is public (served as a plain file next to the JS), which is a
fine tradeoff here — there's nothing secret in the frontend source;
every real permission boundary is enforced server-side by RLS.


## The branch-switch crash: found and fixed

Root cause: `Catalog.jsx`'s data-refresh function was written as a
single-expression arrow with no braces —
`() => loadAllCatalogItems(...).then(setAll).catch(...)` — passed
directly as a `useEffect` callback. The value of that expression is a
**Promise** (`.catch()` always returns one), and React treats
whatever an effect returns as a cleanup function to invoke before the
next run. Switching branches is exactly what triggers that: Catalog
re-renders with a new `staff.branch_id`, React tries to run the
previous effect's "cleanup" before starting the new one, and calling
a Promise as if it were a function throws exactly the reported error.

Every other screen's refresh function was already written as a
braced block (implicitly returning `undefined`, which is what
`useEffect` expects) — Catalog was the only exception in the entire
app, which is exactly why it was the only screen that crashed. Fixed
by wrapping it in braces to match every other page; swept the rest of
the codebase for the same shape and found no other instances.

Getting here took several rounds of stack traces that all turned out
to be non-informative (minified names, then correctly-resolved but
unhelpful React-internals frames) — the crash happens inside React's
asynchronous effect scheduler, which is a context where the
JavaScript call stack genuinely does not preserve the original
calling code, no matter how good the source map is. The source maps
enabled earlier are still a permanent, valuable improvement for any
future crash that *does* originate in a normal render or event
handler, where they'll work as intended immediately.


## Front desk given Credit, Recovered Debt, and Corrections

The database side of this was already correct from when front desk
first got recording rights (39_front_desk_minimart.sql) — the RLS
policies check what someone did (`recorded_by`, `app_owns_recent()`)
or a general "can record" flag, not a hardcoded role list, so front
desk already had the right to use these three pages. The gap was
purely in the app: `front_desk` was missing from More.jsx's visibility
list for all three, and Corrections/Credit had their own internal
`role === 'bar'` checks that would have shown front desk a broken or
read-only view even after the menu item appeared. All three fixed —
front desk staff (Daniel, Mercy, and the rest) now get exactly the
same rights bar staff have: record, view their own department's
credit and recovery, edit their own entries from today and yesterday,
never delete. No database changes needed for this round.


## Sign-out confirmation

Tapping "Sign out" now asks first, since with one phone per person the
main real risk of losing a session is an accidental tap rather than
anything the app was doing wrong. The dialog also reminds people that
on their own phone, closing the app is usually enough — signing out
isn't needed day to day, since the session persists on its own
(Supabase's client keeps it in local storage automatically; this was
already true before this change, nothing new added there).

No credential storage was added, deliberately — the login form already
carries the right `autoComplete` attributes for the phone's own browser
password manager to offer to save and autofill, which is the safe
version of "remember my password" and requires no code in this app.


## Stock count, opened up to staff

Bar and front-desk staff can now count their own department's stock
at the end of a shift and submit it for the auditor — same flow as
storekeeper's counts, with two deliberate limits:

- **Own department only.** The location picker for staff uses their
  assigned location(s) (`boot.locations`), not the full branch list —
  a barman counts his own bar, not any department. Storekeeper and
  above still see every location, unchanged.
- **No "Opening balance" option.** That stays storekeeper/manager/gm/
  admin only — it's a structural reset, not an end-of-shift tally.
  Staff only ever create the ordinary "count" type, and the date is
  locked to today rather than backdatable.

Every count now shows who counted it and, once verified, who verified
it — pulled from the same `counted_by`/`verified_by` columns that
already existed, just not previously surfaced in the UI.

Staff may delete their own count only while it's still a draft
(nothing posted to stock yet, genuinely harmless); once submitted,
removing it requires storekeeper and above, same as before. Reading
is department-wide — anyone assigned to a location can see that
department's counts, whoever did them, same visibility rule already
used for sales and credit.

53_staff_stock_counts.sql carries all of this at the database level;
the app changes are cosmetic on top of policies that now actually
allow it.


## Loading performance

Two separate problems were making branch switches (and, more subtly,
every screen's normal refresh) slower than they needed to be:

- **The app was redoing identity work it didn't need to.** Every
  branch switch re-ran the full bootstrap — an auth check plus a
  staff-table lookup — even though the person's identity hadn't
  changed, only which branch they wanted to view. `loadBootstrap()`
  is now split into `loadStaffIdentity()` (runs once per sign-in) and
  `loadBranchData()` (the part that actually depends on which branch
  is selected). A branch switch now calls only the second half —
  two fewer network round trips before the real work even starts.
- **`v_stock_on_hand` had no supporting index.** This view backs
  almost every screen — Sales, Stock, Store, Counts — and
  `stock_movements` has grown into the largest table in the schema.
  Without an index matching its actual filter (branch + location,
  grouped by item), every read was a full table scan. Added two
  partial indexes matching exactly what the view queries
  (54_performance_indexes.sql), plus smaller ones for `stock_items`,
  `stock_counts`, and `customers` that were filtered by branch
  constantly but never indexed for it.

The identity/branch split is a real, measurable reduction in what
happens on every switch. The indexes should matter more as the two
branches' history keeps growing — the query pattern doesn't change,
but how expensive a table scan is does.
