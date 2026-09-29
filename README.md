# Havilah App

The all-in-one operations app for Havilah Suite Ltd (Awka & Nnewi) —
rooms and front desk, the bar, the restaurant, stock, and credit, all
in one place, so inventory ties directly to income rather than living
in a separate system. Started as a bar/stock inventory app; grew into
covering the full guest stay (check-in through checkout), restaurant
orders (walk-in and charged to a room), and every department's credit
and cash reconciliation, once it became clear these were never really
separate problems.

Shares the Supabase project with the front desk register: same staff,
same branches, one stock ledger.

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


## Daily financials: four requests collapsed into one

`get_daily_financials()` (55_daily_financials_rpc.sql) computes gross
sales, received-at-sale, credit raised, debt recovered, the
payment-method breakdown, and PR/damage figures all in one database
function call — replacing `loadDailySummary` + `loadReconciliation`,
which together fired four separate queries (already concurrent with
each other, but still four round trips). One RPC now returns
everything Sales' reconciliation panel needs.

Runs as SECURITY INVOKER (the default, stated explicitly) — RLS on
sales, sale_payments, stock_movements, and credit_repayments applies
exactly as before, so a bar hand still only sees their own
department's numbers and a GM viewing the branch still sees the
branch total. Only the number of requests changed, not what anyone
is allowed to see.


## In-app alert for submitted counts

Auditor, storekeeper, manager, GM and admin now see a badge when one
or more counts are sitting in "submitted" — on the More tab itself (a
small number, noticed before even opening the menu) and again next to
"Stock count" inside it, with the hint text changing to "N awaiting
your verification".

This is an in-app alert, not a push notification — it updates while
the app is open (checked on load, on branch switch, and every 60
seconds) but won't buzz a phone whose screen is off. A true push
notification would need new infrastructure this app doesn't have yet
(a service worker, browser permission prompts, a server-side trigger
to fire the push) — a real, buildable feature, just a materially
bigger one than what was asked for here.

No database changes — `loadPendingVerifications()` is a lightweight
count-only query against `stock_counts`, and it inherits the same RLS
already governing that table, so each person only ever sees their own
branch's pending count.


## Count deletion narrowed to a specific role list

Deleting a stock count is now storekeeper, GM, auditor, and admin
only — an exact list, not "editor-tier" or "verifier-tier" reused.
Two deliberate consequences worth knowing:

- Plain "manager" role is excluded, even though it has most other
  editor-tier rights elsewhere in the app.
- Auditors gained delete rights they didn't have before (previously
  verify-only).
- The earlier rule letting bar/front-desk staff delete their own
  not-yet-submitted draft is gone — only the four listed roles can
  remove a count now, at any stage short of verified.

Verified counts remain permanently undeletable, unchanged.


## Stock count deletion: two separate rules now, not one

Fixed while implementing this: the app already had a
`CAN_DELETE_COUNT` list (storekeeper/manager/gm/auditor/admin) but it
was wired to allow deleting BOTH drafts and submitted counts with no
split — and along the way, the counting staff member's own right to
delete their own not-yet-submitted draft had been dropped entirely.

Now, matching 56_count_delete_rules.sql exactly:
- **Draft** — only the staff member currently counting it.
- **Submitted** — only storekeeper, manager, GM, auditor, admin. The
  auditor gaining delete rights here is new; previously they could
  verify a count but not remove one.
- **Verified** — nobody, unchanged.

Enforced at the database via `counts_remove`, not just hidden in the
UI — the app's button visibility now matches the RLS policy exactly.


## Cross-department stock movement and conversion

Store now has four modes: Receive, Issue, **Move Between Depts**, and
**Convert** — storekeeper/manager/gm/admin only, same as the rest of
Store.

**Move** transfers stock directly between two departments without
routing through the store — pick From, pick To, add items. Only makes
sense for items that are genuinely one catalog row stocked at
multiple locations (see the Gala/Peanut merge below).

**Convert** records one item becoming a different item at a fixed
ratio you type each time — e.g. 2 bottles of groundnut into 10
plates. Posts as two linked `conversion` movements (one deduction, one
addition) sharing the same note, so the pair reads as one event in
history. The ratio is entered per conversion, not stored as a
permanent recipe — simpler, and a wrong ratio can't silently apply
forever with nobody noticing.

Gala and Peanut 250g (Bottled) were each split into two catalog rows
per location — the same problem Gulder had. Merged into single items
(62b_merge_gala_peanut.sql) using the existing `merge_stock_items()`,
then renamed to drop the location suffix. Moving either between
OpenBar and Minimart is now an ordinary Move, nothing special.

## Corrections now shows who a sale belongs to

Any sale with a customer attached shows "customer: <name>" in its
detail line, and the search box matches on it — so before editing or
deleting an entry, it's clear whose record it actually is rather than
just an item and a price that could belong to any of several people.
Uses "customer", not "debtor" — a sale can have a name attached even
when paid in full cash, not only on credit.


## Auditor: Credit, Recovered Debt, Variances, and Daily Sales

The auditor already had RLS-level read access to sales, credit, and
variance data from early on — it was never actually exposed through
any screen. Added to More: Credit, Recovered Debt, Variances (all
read-only for this role; "Record payment" is explicitly hidden on
Credit for auditor, since the database already refuses to let an
auditor record anything and a visible button that fails on tap is
worse than no button).

## Daily Sales — new, shared page

A genuinely new capability: browse any past day's sales, filterable
by department, for auditor/storekeeper/manager/gm/admin. This is what
gives the auditor sales visibility at all (they have no live Sales
tab, by design — an auditor never records). No date floor other than
"not the future" — unlike the live Sales screen, this is pure viewing,
not backdating a write, so there's nothing to restrict.

## Department filter now actually filters the sales list too

On the live Sales tab, clicking a department chip already filtered
the reconciliation summary, but the list of individual sales below it
still showed every department mixed together — `loadToday()` never
had a location parameter to filter by. Fixed for everyone using that
screen, not just the new page.


## Sales lists show who recorded each entry

`loadToday()` now embeds the recording staff member's name (and, when
a sale was entered on someone's behalf, that person's name too) —
shared by the live Sales screen's "Today" list and the read-only
DailySales history, since both call the same function.

Display rule lives in one place (`whoRecorded()` in format.js) rather
than being written twice: shows the person the sale is attributed to
if it was recorded on someone's behalf, noting who actually entered
it — otherwise just whoever entered it themselves. One shared
definition so the two screens can't drift apart on this the way the
customer-name normalizer once did.


## Auditor's nav: Daily Sales promoted, before Stock

For the auditor specifically, Daily Sales is now a dedicated
bottom-nav tab — positioned before Stock — rather than something
reached two taps deep through More. Every other role still finds it
inside More as before; hidden from the auditor's own More list
specifically so it doesn't appear in two places at once, and the
More tab no longer falsely highlights as active while viewing it
through the dedicated tab.


## Recovered Debt now shows both dates

Each row shows "Credit taken [date] · recovered [date]" — and, when
the customer's credit at that department spans more than one purchase,
"(most recently [date])" too.

Worth knowing why this isn't tied to one exact transaction: a
repayment settles a customer's overall balance, not one specific
credit sale (`credit_repayments.sale_id` exists in the schema but the
app has never populated it — payments are recorded against the
balance as a whole, which is often correct since one payment can
cover several purchases at once). So "date of credit" here means when
that customer's debt at that department first began, not the date of
any single sale — the honest version given how repayments actually
work, and the same convention already used on the Credit page's own
"since" display (63_recovery_credit_dates.sql).


## Credit page: department chips now explicit, not inferred

The department chips on Credit were using the staff-scoped location
list. For storekeeper/manager/gm/admin this happened to equal every
department (they're excluded from location-scoping elsewhere), but
for auditor it only worked because auditors typically have no
`staff_locations` row — the "no assignment = sees everything"
fallback, not a guarantee. An auditor accidentally assigned to one
department would have silently lost visibility into every other
department's credits, with nothing to indicate why.

Fixed to check the role explicitly (`seesAllDepartments`) rather than
rely on that inference — management and audit roles always see every
department's chip regardless of any stray assignment. Confirmed the
underlying RLS (`app_is_auditor()`) already granted unconditional
branch-wide read access regardless of location, so the actual data was
never at risk — only which chips the auditor could click.

"Who recorded this credit" was already shown per row (`by <name>`)
for every role, no change needed there.


## Payment method shown on Sales and Daily Sales lists

Every entry now shows its payment method — POS, Cash, Credit, or
"Split: POS + Cash" when a sale was paid across more than one method.
An entry with no payment recorded at all shows "Unpaid" rather than
blank, since that's exactly the thing worth noticing on a list.

One shared helper (`paymentSummary()` in format.js) used by both
screens, same discipline as `whoRecorded()` — Recovered Debt already
showed its own payment method and needed no change.


## Found: the actual "Ikenna in MainBar" cause

Checked the underlying data directly — every MainBar debtor was
already correctly attributed to MainBar's own staff (Chidera, Prosper,
the Store Manager). Ikenna's name was never in the credit data itself.

The real cause: the staff-filter chips at the top of the Credit page
were loading every bar/front-desk staff member branch-wide
(`loadBarStaff`), regardless of which department chip was selected —
so switching to MainBar still showed Ikenna's name as a selectable
filter option, even though he has no MainBar activity at all. Fixed
to use the same department-scoped lookup already built for the Sales
screen's on-behalf-of picker (`loadStaffForLocation`), and a stale
filter selection now clears when switching departments rather than
silently persisting. No database change — the underlying credit
records were correct the whole time; only the filter chips were
unscoped.


## The "OpenBar debtors showing under Minimart" bug: found

Long diagnostic path, but the finding is genuine: an existing
race-condition guard on Credit's data fetch keyed off only the
location. When switching departments auto-cleared a stale staff
filter (a person from the previous department no longer belonging on
this one), that fired a SECOND refresh — but the FIRST fetch's
response could still arrive while `locId` was correctly Minimart,
carrying the previous department's `staffFilter` inside the query.
That older response was accepted (its location was still current) and
overwrote the newer, correct data. Effect: chips looked right, staff
chips updated correctly, and the debtor list showed the previous
department's rows under the new department's heading.

Fixed by widening the guard from `locId` alone to a combined
`locId|staffFilter` request key — a fetch response now only applies
itself if BOTH the location and the filter it was originally sent for
are still the ones the screen wants. Chased through several rounds
of diagnostics that individually kept turning up clean: database
filtering was correct end-to-end (67, 70), sales attribution was
clean (68b), and the bug was ultimately client-side in a corner
neither the code nor an isolated test could catch without the exact
sequence of clicks that triggers it.


## Awka Store Manager: on-behalf-of removed entirely

Both sales and repayments. Pinned to their specific staff id
(a5ea88b6-...) rather than the storekeeper role, so a role change
doesn't quietly reopen it and Nnewi's storekeeper (or any future
Awka storekeeper) is unaffected.

- Sales: the "Recording on behalf of" picker is hidden for this
  account. A database trigger blocks the same at the write layer,
  so a hand-crafted API call can't work around it either.
- Repayments: the "Record payment" button is hidden on any customer
  whose balance is already attributed to someone else. Deliberate
  choice: credit stays with whoever originally gave it — this
  storekeeper is simply not the one who collects those. Same
  database trigger backs this at the write layer.

An earlier draft of this fix would have credited any storekeeper-
collected repayment to themselves, silently shifting accounting away
from the original credit-giver. That's not what was asked for; the
final version keeps attribution correct and just removes the
storekeeper from the collection path when it isn't their own credit.


## Auditor can correct a submitted count before verifying

Previously, once a count was submitted the counted figures were
read-only for everyone — an auditor faced with an obvious staff typo
(50 entered instead of 5) could only approve the wrong number or
delete the whole count and start over. Now the auditor can edit the
counted quantity directly on a submitted count, then verify.

Chose Option A (overwrite) per the decision — the corrected number
replaces the original. One safeguard kept so it isn't a silent
rewrite: a corrected line is flagged `auditor_adjusted` and shows an
"adjusted" marker, so the history still records that a correction
happened even though the original figure isn't preserved. The
corrected value flows straight into the stock adjustment at
verification (verify reads counted_qty live), and the existing
completeness check still applies — an adjusted line can't be left
blank. Auditor still cannot touch a verified count (locked) or a
draft (belongs to whoever is counting).
74_auditor_edit_submitted_count.sql.


## PR/free and damage now capture a reason

Both were previously bare stock movements with a generic note.

- Damage: a required fixed-list reason (breakage, expiry, spillage,
  theft, spoilage, other) plus an optional note. Save is blocked
  until a reason is picked, so damage can actually be counted and
  investigated by cause. Stored in a new `damage_reason` column,
  constrained to the known set (77_writeoff_reasons.sql).
- PR/free: a free-text "Authorized by / note" field, so who
  authorized it and why is on record. No approval workflow — capture
  only, per the decision.

The reason and note now show on each write-off row in Corrections,
where they'd actually be reviewed. A `v_writeoffs` view is also added
for GM-level investigation across all write-offs with reason, value,
and who recorded each. The new fields thread through the offline
outbox too, so a write-off recorded with no connection keeps its
reason when it syncs.


## Auditor can now record PR/damage write-offs

Explicit, acknowledged exception to the auditor's view-only design,
at the user's request. Scoped tightly at every layer:

- RLS (80_auditor_writeoffs.sql): the auditor gains insert on
  stock_movements for movement_type in (damage, complimentary) ONLY —
  not sales, transfers, issues, or anything else. Their read-only
  stance on everything else is unchanged.
- UI: since the auditor has no Sales screen (where the write-off
  button normally lives), the entry point is their existing Stock
  tab — pick a department, tap an item, the PR/damage sheet opens.
  Non-auditor roles keep recording write-offs on the Sales screen as
  before; Stock stays read-only for them.

The PR/damage sheet was extracted into a shared `WriteoffSheet`
component so the Sales-screen and Stock-screen (auditor) entry points
use one definition — same reason fields, same validation, no drift.
The Sales screen still uses its own inline copy for now; the shared
component is what the auditor path uses. (Worth unifying the Sales
screen onto it later, but that's a bigger refactor of a
daily-critical screen and wasn't needed for this.)


## Stock code hidden from catalog

The "Stock code" input is removed from the add-item form — it wasn't
useful to enter by hand and wasn't shown on the catalog list anyway.
The column stays (it has a per-branch unique NOT NULL constraint, so
it can't just be dropped), and is now auto-generated from the item
name plus a short random suffix. createItem retries once with a fresh
suffix on the rare chance of a collision, so the unique constraint
can never surface as an error the person can't act on. No database
change.


## Unfinished-task nudge (draft stock counts)

A persistent banner now appears on every tab when a stock count has
been started but not submitted — the "incomplete task left rotting"
case. Tapping it jumps to the Counts tab to finish or discard; it
hides itself while you're already on that tab.

Deliberately scoped to draft counts rather than a generic
"any incomplete task" system: a draft count is the one genuinely
real, resumable started-but-unfinished state in the app, and it maps
exactly to the example given. It reuses the existing stock_counts
table and its RLS — so a bar hand sees only their own unfinished
drafts, a manager/gm sees the branch's — on the same 60s refresh
cadence as the awaiting-verification badge. No database change.
(Submitted-awaiting-auditor counts already had their own badge from
earlier; this covers the other end — never submitted at all.)


## Store history extended to all four modes

Previously only Issue (OUT) had a history list. Now Receive (IN),
Move Between Depts, and Convert each have their own, matching the
same collapsible pattern:

- Receive: what's arrived into the store, with supplier/received-from
  note.
- Move: what's left the selected FROM department (the one picked
  first in Move mode).
- Convert: conversions at the selected department, showing the full
  "X → Y" detail from the movement note (one row per conversion, read
  from the produced-item side).

One shared reloadHistory() drives all four — it picks the right query
for the active mode and is called both on mode/department change and
after any successful save, so a just-recorded action shows
immediately. No database change; all four read the existing
stock_movements rows.


## Cross-branch default_location_id bug (zero stock until a tab is tapped)

Kelvin and Caleb (both Nnewi bar hands) had default_location_id
pointing at AWKA's OpenBar — a different branch's location. On load
their pages defaulted to an id that doesn't exist in Nnewi's data, so
every stock total read zero until they manually tapped the OpenBar
tab (which set the correct Nnewi id). Classic "works only after I
click something" symptom.

Fixed both ways:
- Code (loadBranchData): the stored default is now validated against
  the locations the person can actually see in the CURRENT branch. If
  it doesn't match (cross-wired or stale), it falls back to their
  first visible sales point. So no default can ever blank a screen
  again, for any account, on any page, including after a Nnewi↔Awka
  switch. This is the durable fix.
- Data (103_fix_crosswired_defaults.sql): repointed the two affected
  accounts to their own branch's assigned location, matched via their
  staff_locations rather than a hardcoded id. Not strictly needed once
  the code tolerates it, but the stored data should be correct too.


## Branch switch left the location chip unhighlighted (GM)

On Sales, Credit, and Recovered Debt, the selected-location state was
set once via useState's initial value — which React ignores on later
renders. So when the GM switched branch, the selected location id
stayed frozen at the OLD branch's OpenBar, matching no chip in the
new branch: nothing highlighted until a manual tap re-set it to a
valid id.

Fixed on all three pages with a re-sync effect keyed on
staff.branch_id: when the branch changes and the current selection
isn't a valid location for this branch, it resets to the branch's
default. Related to but distinct from the cross-wired
default_location_id fix — that was a bad stored default; this is
stale in-component state after a switch.


## PWA install — activated for iPhone and Android

The PWA groundwork already existed (manifest, full icon set, iOS
Safari meta tags, a well-written network-first service worker that
never caches live data). Two gaps closed:

- **Service worker was never registered.** sw.js sat in public/ doing
  nothing. Now registered in main.jsx (after load, non-blocking,
  fails silently) so the offline shell actually works.
- **No install guidance.** Added InstallHint: on Android/Chrome it
  catches beforeinstallprompt and shows a one-tap Install button; on
  iOS Safari (no such event exists) it shows "Share → Add to Home
  Screen" instructions after a short delay. Hidden when already
  installed (standalone), and stays dismissed 14 days once closed so
  it never nags.

No app stores involved: staff install straight from the browser.
iPhone users must use Safari (iOS only allows PWA install from
Safari); Android is more forgiving. Updates are instant on next load
after a Netlify deploy — no review, no fees.


## New app icon (inventory boxes)

Replaced the clipboard-and-check icon with three dark boxes stacked in
a pyramid on the amber tile — reads clearly as stacked inventory at
any size, from a 16px browser tab to a home-screen tile. Regenerated
all referenced files from one design (icon.svg, icon-192, icon-512,
apple-touch-icon 180, maskable 512, maskable svg) via cairosvg. The
maskable version is full-bleed (no rounded corners) so Android can
crop it to any shape; the regular one keeps the rounded tile for
browser tabs. No code change — the manifest and HTML already point at
these filenames.


## In-app logo matches the new icon

Updated the Logo component (used on the sign-in page and the header)
from the old clipboard-and-check line drawing to the three stacked
boxes, matching the new app icon. Drawn in currentColor so it stays
amber via text-amber on the app's dark background — just the boxes, no
tile, since the app already provides the dark backdrop. One component
change updates both the large sign-in logo and the small header logo.


## Reception & Order — charging items to a hotel room

New "Charge to a room" button on the Sales screen, available to any
staff who can record sales (not gated to managers, since taking a
room order is an everyday task, not an admin action).

This isn't a new subsystem — it writes directly into the front-desk
app's own `stays`/`orders`/`order_items` tables, in the same Supabase
project. Confirmed via their actual schema and RLS (not guessed from
their frontend code): both branch ids matched exactly what this app
already uses, and `orders`/`order_items` already had a fully
permissive `can_see_branch()` policy — no new security was needed for
this app's staff to write there.

What WAS missing, exactly as the front-desk app's own README flagged:
"when inventory arrives, setting [stock_item_id] is the only change
needed." Two things, not one — `order_items` had no `location_id`, so
there was no way to know which department's stock a room charge
should decrement. 108b adds that column and a trigger
(`sync_order_item_stock_movement`) mirroring the existing
`sync_sale_stock_movement` exactly — same insert/update/delete
symmetry, so editing or deleting a room charge doesn't leave a stray
stock movement behind. Uses a new `room_charge` movement type (108a)
rather than reusing `sale`, so stock history can tell the two apart.

Flow: search a live stay by room number or guest name → pick an item
from a NEW cross-department picker (RoomItemPicker) that shows every
department actually holding stock of it, not just the one you're
standing at — this is what lets a food order taken at OpenBar pull
from Kitchen's stock. Each item posts immediately as its own order,
matching exactly how the front-desk's own folio drawer already adds
charges one at a time — so a guest's bill looks identical regardless
of which app added it to. Category (drink/food/minimart) is inferred
from the department name, matching the three categories the front
desk already uses.

Deliberately does NOT create a `sales` row — a room charge is settled
by the front desk at checkout, not by this department's own till, so
folding it into this app's own daily reconciliation figures would
double-count revenue that hasn't actually been collected yet. It only
affects stock levels, which is correct: the drink is gone the moment
it's poured, whoever eventually pays for it.


## Restaurant orders at OpenBar/MainBar — attributed to Kitchen

New "Add a restaurant order" button on Sales, using the same
cross-department picker built for room charges. Per the explicit
decision: a walk-in food sale taken at OpenBar counts toward
KITCHEN's daily takings, not OpenBar's — the department that actually
fulfilled it gets the credit, whoever recorded it.

Mechanically: basket lines now carry an optional locationId, defaulting
to the bar's own department for normal items (nothing changes there)
but set explicitly when picked via the cross-department picker.
saveBasket uses each line's own location for both the resulting
sale's location_id (so it flows into the RIGHT department's daily
figures) and the stock deduction (so it decrements Kitchen's stock,
not OpenBar's). Fixed the same class of bug this exposed in the
existing "more than the shelf shows" warning, which was checking
every line against the bar's own stock regardless of where it was
actually sourced from — now checks each line's real location. The
offline-outbox payload carries the same per-line location through, so
a queued cross-department sale doesn't lose it on replay.

Extracted the "which departments can fulfil an order" rule
(orderableLocations in format.js — sales points plus Kitchen,
excluding Housekeeping/Others/the store) into one shared definition
used by both this and the room-charge flow, rather than two copies
that could drift.

## Room Board — Phase 1 of the front-desk consolidation

Confirmed, real goal now: full replacement, staff stop using the
separate front-desk app entirely. Read the whole reference app
(RoomBoard, CheckIn, GuestRegister, FolioDrawer, Payments, Settings)
to scope this honestly rather than guess, and proposed five phases:
Room Board (view-only) → Check-in & bookings → Folio & checkout →
Settings → retire the old app. This is phase 1.

RoomBoard.jsx reads v_occupancy_today — confirmed its real columns
directly against the live database before building, not inferred
from the front-desk app's frontend code. View-only by design for this
first phase (no out-of-service toggle yet) — status tally, outstanding/
deposit totals, and a card per room showing guest, checkout date,
nights remaining, and amount owed.

Front desk gets it as a dedicated tab (same treatment as the
auditor's Daily Sales) since it's their primary tool; storekeeper/
manager/gm/admin reach it through More for oversight. Same
double-highlight bug class fixed proactively this time, since
roomboard sits in both places depending on role — the More tab
correctly doesn't light up when front desk is viewing Rooms through
their own dedicated tab.

Next phase (check-in & new bookings) is a real write path into a
system currently live and in daily use — worth a dedicated pass with
its own verification, not tacked onto this one.


## Restaurant orders are now genuinely typed — no catalog item, no stock

Reworked from last turn's version, which required picking a real
catalog item. Confirmed the actual requirement first: a plate of food
isn't a countable stock unit, so Kitchen dishes should never need a
tracked "12 left on the shelf" the way a bottled drink does.

Checked every dependent piece directly against the live database
before writing anything, given this makes sales.stock_item_id
nullable for the first time in the whole system — the single most
relied-upon table here:
- v_item_popularity needs no change — a typed order correctly falls
  out of "which catalog item is popular" on its own.
- v_sale_variances DID need a fix — was (almost certainly) an inner
  join, which would have silently hidden any real payment shortfall
  on a typed order from the variance report entirely. Now a left join
  with a fallback to the typed description.
- sync_sale_stock_movement now skips entirely when stock_item_id is
  null — no movement to create when there's no stock.
- log_sale_change already tolerated a missing item name gracefully;
  improved it to show the typed description instead of a bare '?'.

sales gained a nullable description column, with a check constraint
requiring every sale to have EITHER a real item OR a typed
description — never neither. Both entry points (walk-in Sales, and
now the room-charge flow too) always attribute a typed order to
Kitchen's own daily figures, matching the earlier decision, with no
stock deducted anywhere.

Swept the whole app for anywhere a sale's item was assumed to exist
(itemById[x.stock_item_id]?.name with no fallback) and fixed each one
against the real typed description instead — the basket display, the
per-line price/tier editor (which now hides the tier section entirely
for a typed line, since tiers are a catalog-item concept that doesn't
apply), the over-stock warnings (skip typed lines, nothing to check),
the offline-outbox payload, Credit's ledger, Corrections' search and
display, DailySales, and the printed receipt.

RoomChargeSheet now offers two clearly separate buttons — "add a
drink or minimart item" (unchanged, catalog-based) and "add a
restaurant order" (new, typed) — rather than forcing every room
charge through the same catalog picker that was never right for food
in the first place.


## Split payment method for Credit repayments

"Record payment" on Credit now has a Split option, matching the same
pattern already used for split sale payments. No schema change needed
— credit_repayments was already one row per method per payment, same
as it's always been; "split" just means saving more than one row for
the same repayment when more than one method has a non-zero amount.
Each part goes through the same save/queue path as a single payment
always has, so the offline-outbox replay handler needed no changes.

## Kitchen renamed to Restaurant — now a real sales point

Confirmed the exact current state on both branches before touching
anything: both had a "Kitchen" location, is_sales_point=false,
consumes_on_issue=true (a back-of-house consuming department, not a
walk-up sales point). Renamed to "Restaurant" and flipped both flags
to match OpenBar/MainBar/Minimart — it now appears as a proper tab
everywhere sales points do, and holds a running stock balance instead
of expensing everything issued to it immediately.

Updated every hardcoded reference to "Kitchen" across the app to
match — most importantly the regex that finds which location typed
restaurant orders get attributed to (SalesEntry's addTypedOrder),
which would have found nothing and silently broken revenue
attribution if left unfixed. Branch-wide price tiers and payment
methods already apply to every sales point automatically, so nothing
extra was needed there. Staff assignment to Restaurant (who actually
works there) is a separate step, same as any other department.


## Restaurant and Reception: no catalog selling

Restaurant now shows only "Add a restaurant order" — the "+ Sell
Item" button is hidden there, along with the tier selector and PR/
Damage (which called the item picker directly, bypassing "+ Sell
Item" entirely — hiding just the one button wouldn't have actually
stopped someone reaching the catalog picker through PR/Damage, so
both needed the same guard).

Reception shows neither — a plain message pointing to the Rooms tab
instead, since check-in, checkout, and folio settlement belong there,
not on a sales screen. Every sales-related action is hidden for
Reception specifically: Sell Item, PR/Damage, the tier selector,
Charge to a room, Add a restaurant order, and Recording on behalf of.

isRestaurant/isReception computed once, near the top of the
component, and reused by every conditional — avoids the exact
"several separate checks that quietly drift apart" risk that's shown
up before in this build.

The rest of what was asked for Reception — check-in, checkout, room
status, rate handling, overstay fees, folio settlement, payment,
guest register — is the remaining phases of the front-desk
consolidation already scoped earlier (Room Board is done; check-in
& bookings, folio & checkout, and settings are still ahead). That's
real, substantial work on a live system and deserves its own focused
pass rather than being folded into a UI-visibility fix.


## Check-in & new bookings — phase 2 of the front-desk consolidation

Every piece of this was verified directly against the live database
before writing anything — not inferred from the reference app's
frontend code:
- stays_one_live_per_room is real (a partial unique index on room_id
  where status is reserved/occupied) — the database itself prevents
  two guests being checked into the same room, even under a race
  condition, so the app doesn't need to build that protection itself,
  only handle the error gracefully if it fires.
- guests.name_key and phone_norm are both GENERATED ALWAYS columns,
  using a specific regex (strips a leading title, keeps only
  alphanumerics). Replicated that exact pattern client-side
  (nameKey() in format.js) — required, since a generated column can't
  be searched against directly.
- branches.allowed_cycles genuinely differs — confirmed Nnewi has no
  'monthly' where Awka does, matching the reference app's own code
  comment exactly. The cycle picker respects this per branch rather
  than offering an option a branch doesn't use.
- RLS on stays/guests was already fully open (same can_see_branch
  pattern as orders/order_items) — no new policy needed.

Guest matching follows the same rule as the reference app: same
phone at the same branch reuses the existing guest; failing that, the
same normalized name does too (so "Mr. Alphonso" and "alphonso" match
without creating a duplicate), backfilling a phone number a returning
guest didn't have on file before.

Reachable from Room Board via "+ New booking," opening as a
full-screen sheet — closing it refreshes the board immediately, so a
just-booked room's status updates without needing a manual reload.

Folio, checkout, and settling a stay's bill are still the next phase —
this covers creating a booking, not the rest of a stay's lifecycle.


## Rate type labels: now genuinely per-branch

CheckIn's rate-type dropdown was showing generic English labels
(Standard/Discounted/Short-time) I'd hardcoded rather than the real
branch-specific ones. Checked first, and the columns
(label_rate_standard/alternate/short on branches) already existed AND
were already populated correctly — Nnewi: Season/Off-Season/Short-Time
Rate; Awka: Full/Discounted/Special Rate. Pure app fix — read the real
values instead of ignoring them. Folded into the same query that was
already fetching allowed_cycles (loadBranchStaySettings replaces
loadBranchCycles), rather than add a second round trip to a table
already being queried.


## Phase 3 — Folio, payment, and checkout

Same full-verification discipline as check-in: read the reference
FolioDrawer completely (not the partial read from earlier in this
build), then confirmed every real fact directly against the live
database before writing anything —
- payments' real columns (paid_at, is_overstay, cycle, remark —
  not "note", approved_by/approved_by_label unused for now)
- v_stay_folio's real columns, including overstay_charge
- checkout itself has no special trigger (any staff on the branch,
  same permissive RLS as everything else) — but REOPENING a
  checked-out stay is genuinely enforced server-side
  (enforce_checkout_reversal): same-day undo is open to any active
  staff, an older one needs manager/gm/admin. Got the exact function
  body rather than guess at matching the reference app's client-side
  prediction of it.

Scoped deliberately narrow, same as phases 1 and 2: view the folio
(charges, payments, balance), record a payment (POS/cash split,
over-stay flag), check out. Left out for later: mid-stay rate/cycle
editing, overstay fee management, and guest-record deletion — each
has its own role-restricted trigger (enforce_overstay_fee,
stamp_rate_adjustment) worth verifying properly rather than folding
into this pass.

Caught a real gap before it shipped: Folio only ever opens from
tapping a room card on the board, and v_occupancy_today only shows
CURRENT occupancy — once checked out, a room reverts to vacant
(stay_id becomes null) in that view. Built a whole "undo checkout"
section, then realized it could never actually be reached through
this entry point and removed it (the data function stays in data.js,
tested and ready) rather than ship a button that looks real but isn't.
Reaching an already-checked-out stay for reopening needs its own
search, the same way check-in searches rooms and room-charging
searches guests — a genuine follow-up, not done here.

Also caught a second instance of the exact unbraced-effect bug that's
hit this codebase before, in Folio's own refresh function — passed to
useEffect(refresh, [...]) as a named function rather than inline,
which the usual inline-only sweep didn't catch. Broadened the check
to look for the pattern itself (an unbraced arrow returning a promise
chain) rather than just its most common inline shape.


## Split payment for Rooms

Rebuilt Folio's payment section to genuinely match Credit's pattern
(single-method chips defaulting to one, "Split" revealing per-method
inputs with a running match check) rather than the "always show two
fields" approach it started with, which was functionally similar but
a different interaction style — real inconsistency worth fixing, not
cosmetic.

Checked the real payments.method enum first rather than assume it
matched the reference app's UI: pos, cash, transfer, AND credit.
Transfer was genuinely missing before (the reference app's own folio
drawer only ever exposed pos/cash). Credit excluded on purpose, same
reasoning as Credit's own repayment picker — recording a "payment" by
credit is a contradiction, credit means it hasn't been paid yet.

Payment methods offered now come from the branch's own configured
list (boot.methods, filtered), not a hardcoded array — matching how
the rest of the app already respects per-branch configuration (the
same care already given to allowed_cycles differing by branch).

recordStayPayment generalized from named pos/cash parameters to a
plain parts array, matching the same shape Credit's split submission
already builds, rather than two separate purpose-built parameters.


## Rooms payment: back to POS/Cash only

Reverted the branch-config-derived method list — Rooms payment is now
explicitly hardcoded to pos/cash, not Transfer, per direct
instruction. Deliberately not deriving from boot.methods anymore for
this screen, since the exact set was specified directly rather than
left to branch configuration.


## Closing the two Folio gaps: reopen search, rate/overstay editing

Verified both remaining triggers directly before writing anything
against them:
- enforce_overstay_fee: setting the EXACT branch default is open to
  anyone; a different amount or removing it entirely requires
  is_supervisor() — confirmed as role in ('gm','admin') specifically,
  NOT manager. A genuinely narrower set than the manager/gm/admin
  group that governs undoing an old checkout — the two are not the
  same rule, and the UI now reflects that distinction exactly rather
  than reusing one role list for both.
- stamp_rate_adjustment: no role restriction at all on changing
  daily_rate — anyone can, the trigger just auto-stamps who and when.
  billing_cycle and scheduled_out have no trigger governing them
  either.
- branches.overstay_fee is a real, populated per-branch default
  (Awka ₦10,000, Nnewi ₦15,000) — folded into the same
  loadBranchStaySettings call already fetching allowed_cycles and
  rate labels, rather than a fourth separate query to branches.

Reopen search (ReopenSearch.jsx): checked-out stays don't appear in
v_occupancy_today, so this queries stays directly, filtered to the
last two weeks, searchable by room number or guest name — same
interaction shape as check-in's room search and room-charging's guest
search. Reachable from Room Board via "Recently checked out,"
reusing the exact same Folio component the room-tap flow already
uses. reopenStay() — written last phase but unreachable until now —
finally has a real call site.

Rate/cycle editing and overstay-fee management both live inside
Folio now, for a live stay only. The overstay section shows the
branch default clearly and lets anyone set exactly that value;
attempting anything else is blocked in the UI for non-GM/admin roles
with an explanation, while the trigger remains the actual enforcement
either way — matching the same "UI predicts, database enforces"
relationship already established for checkout reversal.

Caught and fixed two smaller things while writing this: a needlessly
roundabout way of computing the GM/admin check (filtering a
role list down to itself before checking membership, when a direct
array check said the same thing clearly), and a rate-type label
constant that was defined but never actually used anywhere — removed
rather than left sitting as unreferenced code.


## Restaurant and Reception activity feeds

Restaurant: confirmed rather than assumed — typed orders already save
as real sales rows with location_id set to Restaurant, and loadToday
has no inner join that would exclude a null stock_item_id, so its
Today list was already correctly showing typed orders with no changes
needed. Verified this by reading the actual query and row-rendering
code, not just asserting it works.

Reception: genuinely different, not a bug — Reception creates no
sales rows at all by design (every sales action is deliberately
blocked there), so its old "Today" section would always show empty.
Built a real parallel instead: a "Today at Reception" list of payments
actually collected, joined to the guest and room for context, since
that's the true equivalent of a bar's daily sales — money collected,
not items sold. Hid the old sales-based Today section specifically
for Reception (including the reconciliation cards above it, which are
built from sales data that doesn't apply there either), so the two
lists don't sit stacked with one of them permanently and confusingly
empty.

Also updated stale copy in the Reception message — it used to say
check-in/checkout/settlement were "still coming," which stopped being
true once Phase 3 shipped.


## GM/Admin delete for training records — Restaurant and Reception

Restaurant: a Delete button on each Today-list row, GM/admin only,
scoped specifically to the Restaurant tab. Reuses the existing
deleteEntry function unchanged (already correctly removes
sale_payments before the sale, letting the existing trigger clean up
any stock deduction) — no new deletion logic needed, since a typed
order is just a sales row like any other.

Reception: deletes an entire training booking, not a single row —
confirmed this needed to be different before building it, since the
new payments-only activity feed doesn't cover a whole practice
check-in. Found the delete_stay RPC already exists in the shared
schema, already enforces is_supervisor() (GM/Admin) at the database
level, and already cascades correctly through order_items → orders →
payments → stays in the right order. No new database logic
required — the app just calls it. Lives in Folio as "Delete this
booking," available regardless of whether the stay is live or already
checked out, since training data can end up in either state.

Both use the same sheet-based confirm pattern already established in
Corrections, rather than a browser confirm() dialog.


## Phase 4 — Settings: room rates and the over-stay default

Read the reference app's Settings screen completely before building
anything — turned out narrower than the phase name suggested: no room
creation, no category management, just rate editing per room and the
branch-wide over-stay default. The database actually permits more
(rooms_write, rooms_delete, and all of room_categories are real,
enforced policies) but the reference app never built UI for any of
it — matched that proven scope deliberately rather than silently
build beyond what was shown to be needed, and flagged the gap rather
than pretend it doesn't exist.

Verified both real permission checks directly rather than trust the
reference app's variable names: can_manage_rooms() is genuinely
manager/gm/admin (matches canManageRooms exactly), while the
overstay-fee default still requires is_supervisor() — gm/admin only,
the same narrower set already confirmed for a stay's own overstay
charge. Room rates need manager and up; the branch default needs GM
or admin specifically. Both are real RLS policies, not app-side-only
conventions — confirmed rooms UPDATE/INSERT/DELETE and branches
UPDATE are all genuinely gated, not just permissively open like most
of this shared schema.

Reused loadBranchStaySettings (already fetching allowed_cycles and
rate labels) for the overstay default too, rather than a fourth
separate query. Named the page StaySettings, not Settings — this
app's own More menu already functions as a settings surface in the
broader sense, and a bare "Settings" page name would be ambiguous
next to everything else already living there.

Phase 5 — retiring the separate front-desk app — is the one piece of
the original plan left, and only really makes sense once all of this
has held up under real daily use for a while.


## Reception and Restaurant represented in Credit and Recovered Debt

Restaurant: verified rather than rebuilt. Both pages already filter
departments purely off is_sales_point with nothing hardcoded, and
loadBalances is a plain generic filter — a credit sale at Restaurant
already flows through the exact same customers/sales/credit_repayments
system as everywhere else. Worth a real test to confirm end to end,
but nothing needed changing in the code.

Reception: genuinely new work, since guest room debt lives entirely
in stays/payments — a different schema Credit and Recovery had never
queried. Both pages now branch on the selected department: Credit
shows guests with an outstanding room balance and lets staff record a
payment against it directly (reusing recordStayPayment, the same
function Folio's own payment form calls); Recovery shows a history of
room payments collected, same shape as its existing customer-repayment
view. Reception's guest-payment sheet deliberately doesn't gain
Recovery's Edit capability — that's built specifically around
credit_repayments, a different table with different semantics, and
extending it to payments wasn't asked for here.

Building a fourth near-identical split-payment UI (Sales, Credit, and
Folio each already had their own copy) was the point where duplicating
further stopped making sense — extracted PaymentMethodPicker as a
shared component and switched Credit's and Folio's existing inline
versions over to it too, rather than leave three-going-on-four
independent copies that could quietly drift apart from each other.

Caught a real JSX bug while building Credit's Reception branch: wrapping
two sibling elements in one conditional without a Fragment, which
esbuild correctly refused to compile — fixed immediately, not a change
that shipped broken.


## Reception and Restaurant in Credit/Recovery — the real gap was narrower than expected

Before building anything, checked the actual current state of both
pages rather than assume from the request alone — and found most of
this already built: Credit.jsx already had guestBalances,
submitGuestPayment, and a full guestPay sheet using
PaymentMethodPicker; Recovery.jsx already had loadRoomPayments and a
complete day-grouped room-payment history. Restaurant needed nothing
at all — it was already correctly represented via the same dynamic
salesPoints filtering every other department uses.

The one genuine gap, exactly matching what was reported: no way to
print a guest's room statement anywhere. Credit.jsx's own customer
statement printer (printStatement/id="statement-area") was complete
and working — but nothing equivalent existed for a room stay.

Built FolioStatement.jsx using this app's own proven print
infrastructure (.invoice-print/.invoice-table, the same printOnly()
toggle Receipt.jsx already uses) rather than the reference app's
portal-based approach, which it only needed because of its own drawer
nesting — this app doesn't have that problem, so a portal would have
been unnecessary complexity. Wired it into two places: Folio.jsx (a
"Print guest statement" link, alongside edit/delete), and Credit's
guestPay sheet (fetching the fuller breakdown via loadFolio — the
same function Folio.jsx already calls — since guestPay's own state
only carries what the payment form itself needs).


## Corrections: departmental staff scoped to their own department(s)

Checked the actual current behavior before assuming what was broken —
Corrections already restricted bar/front_desk staff to their own
RECORDED entries (via ownOnlyStaffId in loadActivity), which is a
different axis than department scoping entirely. The real gap: its
department chips were built from allLocations (every department in
the branch) with no distinction by role, and defaulted to "All
departments" for everyone. Harmless for someone with exactly one
department, but for anyone assigned to more than one (Kate: Minimart
+ Reception), it meant seeing both mixed together by default with no
way to view one at a time, and chips for departments they've never
worked in cluttering the picker.

Confirmed the intended scope first rather than guess: still their own
entries only (unchanged), just correctly filterable to one department
at a time when they have more than one. Editors (storekeeper and up)
keep seeing every department with an explicit "All departments"
option, matching their legitimate oversight role — this only tightens
scoping for bar/front_desk specifically, using the same
locations-vs-allLocations distinction Credit.jsx already established.
Defaults to staff.default_location_id, matching every other
department-scoped screen in the app.

Wired the location filter into loadActivity's actual query too
(added the parameter, then used it — a capability sitting unused
would have been the wrong kind of finished), rather than leave it as
purely client-side filtering. Kept the client-side filter as well,
as the same defense against stale, out-of-order responses Credit.jsx
already relies on for its own department switching.


## Credit page: newest activity first

loadBalances (the "Owed to [department]" list) was sorted by balance
amount, not by date, despite each row already showing
last_credit_date. Changed to order by last_credit_date descending.
Checked Recovery's two queries too, since dates matter there just as
much — both were already correctly newest-first, and since they get
grouped into a Map afterward, JS preserves that insertion order, so
the day-groupings there were already right without any change needed.
Since every department's Credit view calls the same loadBalances
function, this one fix applies uniformly across all of them, not just
whichever department happened to be selected.


## Edit and delete for room-charge orders

Folio's Orders section was purely read-only until now. Added Edit for
description/qty/unit price and Delete, with the exact permission
split requested: Delete is GM/admin only; Edit is available to that
same pair OR whoever originally placed the order (orders.served_by),
for self-correction — mirrors the existing pattern in Corrections
where the person who recorded something can fix their own mistake but
only editors can remove entries outright. Deliberately left off a
time-window restriction here, unlike Corrections' today/yesterday
limit — a room charge can belong to a stay spanning several nights,
so restricting self-correction to "yesterday" would have been wrong
for this specific context.

No new stock logic needed — sync_order_item_stock_movement (built
when room charges first shipped) already handles update and delete
symmetrically on its own. Delete also cleans up the parent order if
the deleted line was its only item, since every order/order_item pair
here is 1:1 — otherwise a single-item delete would leave an empty,
orphaned order behind.

loadFolio now selects served_by on orders (needed for the permission
check) — wasn't fetched before since nothing used it.


## Recovery: who collected, and a delete for practice payments

loadRoomPayments now selects received_by, joined to staff for a
display name — shown on each room-payment row as "collected by X",
matching how customer repayments already show a collector.

Added a GM/admin-only delete for a single room payment — deliberately
simpler than deleting a whole training booking (delete_stay), since
this never touches the stay itself. If training happened against a
real, live room, the room's actual booking and every other real
charge or payment on it stay completely untouched — only the one
erroneous payment row is removed, and nothing references a payment
row elsewhere, so there's nothing else to clean up.

## Restaurant: room-charged food now shows on the Today list

Confirmed the actual gap first: a food order charged to a room lives
in orders/order_items, never in sales, so Restaurant's own Today list
(which only ever queried sales) never showed it at all — a real,
confirmed blind spot, not a guess. Built loadRestaurantRoomCharges to
pull today's category='food' order_items with their guest/room
context, and merged it into the same Today list sales already
populate, sorted together chronologically (using the parent order's
created_at, since order_items themselves have no timestamp of their
own).

Room-charged entries render distinctly — "Charged to Room X · guest
name" instead of a tier/payment summary, since neither applies to a
room charge. The existing GM/admin training-delete button now handles
both kinds correctly: deleteOrderItem for a room charge (reusing what
was already built for Folio's own order editing, including its
orphaned-parent-order cleanup), deleteEntry for a walk-in sale, same
as before.


## Restaurant order type: Standard, PR/Damage, Staff

Applies to both walk-in restaurant orders and room-charged ones, per
explicit confirmation both are needed — PR and Damage are one
combined type with both an approver-note field and a damage-reason
field available, rather than two separate types.

The real risk, checked before writing any schema change: get_daily_
financials computes creditRaised as gross sales minus received. A
written-off order recorded with its real value and no payment would
have silently inflated creditRaised, making it look like a customer
owed money nobody actually owes. Fixed by excluding order_type <>
'standard' from the gross-sales calculation — the row keeps its real
value (useful for the Today list and future reporting), but the
financial aggregate treats it the same way catalog PR/damage
write-offs already sit in their own nonRevenue bucket rather than
polluting the sales figures.

Checked a second dependent that would have been easy to miss:
v_stay_folio's orders_charge sums order_items.amount with no filter
at all. A written-off room-charge would have silently overcharged the
guest for something meant to be free — confirmed this against the
view's real definition, not assumed, and fixed it the same way.

Non-standard orders bypass the normal basket/payment flow entirely —
a direct save with no sale_payments or guest charge created, the same
shape the existing catalog PR/Damage write-off already uses rather
than trying to thread "no payment required" through the ordinary
payment machinery. damage_reason reuses stock_movements' exact fixed
list; writeoff_note is free text for who approved a PR comp or any
other note.

Shown with a small colored tag (PR/Damage in clay, Staff in amber)
everywhere a restaurant order appears — Sales' Today list, the
room-charge summary, and Folio's order lines — so a write-off is
never visually indistinguishable from a normal paid order.


## Auto-update, and renaming to Havilah App

Auto-update: checked the existing service worker first rather than
assume what was missing — it was already well-designed for fetching
fresh content (network-first, skipWaiting() on install), but nothing
told an already-open tab to actually pick up a new version once
installed. That's the real gap staff would have hit: leave the app
open for a shift and silently keep running old code.

Deliberately didn't build a forced silent reload — that risks losing
someone's half-built sales basket or an open sheet mid-task, which is
a real cost, not a hypothetical one. Built the safer version instead:
swUpdate.js actively checks for a new version every 5 minutes (a
long-open tab can't rely on the browser's own infrequent background
checks) and detects the moment a new version has actually taken
over, notifying UpdateBanner — a small one-tap "new version ready"
banner, matching PendingBanner's exact existing pattern, so this
class of notification stays consistent app-wide.

Renamed user-facing branding from "Havilah Inventory" to "Havilah
App" everywhere it appeared: the login screen, the browser tab title,
and the PWA manifest (what shows on a home screen once installed).
Deliberately left package.json's internal name and the deployed
folder/repo name untouched — renaming those has real consequences
(the Netlify site URL, git remotes) that weren't part of what was
asked, and changing them silently could break your existing
deployment setup.


## Icon set: Concept D (Suite Grid), full production set

Generated every required size from the chosen concept: icon.svg
(rounded tile), icon-192/512.png, icon-maskable.svg and its 512px PNG
(full-bleed, same safe-zone-shrink convention the original icon
already used), apple-touch-icon.png at 180px (Apple's current
standard). Verified the 512px and maskable renders visually before
finalizing, not just trusted the rasterization blindly.

Caught one detail that would have quietly broken: index.html's
mask-icon (Safari's pinned-tab feature) requires a genuinely
monochrome silhouette — the browser fills the whole shape with one
color, ignoring anything else in the file. The new four-color icon
would have rendered wrong there. Built mask-icon.svg as a proper
single-color variant specifically for that one purpose, rather than
point Safari at an SVG it can't use correctly.

Logo.jsx (the in-app header mark) now bakes its four colors in
directly rather than using currentColor — the original single-tone
boxes could inherit text-amber from whatever styled them, but a
four-color mark can't work that way. Removed the now-meaningless
text-amber class from both places Logo is used (Shell's header,
Login's screen) rather than leave dead styling sitting there.


## Fixed: the update banner structurally could never fire

Traced this rather than guess — browsers detect "a new service
worker exists" purely by comparing sw.js's own bytes against what's
already installed. public/sw.js is a static file Vite copies
unchanged into every build (only the React bundle's own JS/CSS get
hashed); on a normal feature deploy its bytes were always identical
to what was already there, so the browser correctly saw "nothing
changed" and never installed anything new, no matter how much the
actual app underneath had changed. controllerchange — the event the
whole update-banner mechanism depended on — could structurally never
fire from a real deploy. Not a timing issue, not a platform quirk —
the detection was watching for something that couldn't happen.

Fixed with a small Vite plugin (stampServiceWorker in vite.config.js)
that rewrites dist/sw.js right after every build, injecting a real
build timestamp into the cache name. Verified directly, not just
assumed: ran two builds back to back and confirmed the stamp
genuinely differs each time, then diffed a normalized dist/sw.js
against the source to confirm nothing else in the file was touched
by the regex replacement. This also fixes a second, quieter bug as a
side effect — the old-cache cleanup in activate() was comparing
against a cache name that never changed, so it was silently a no-op;
now that the name is genuinely unique per build, stale caches from
previous deploys actually get evicted on update, as originally
intended.

This exact deploy is the first one where sw.js's bytes genuinely
differ from whatever's currently installed on any device — so this
push itself should be the first one people's already-open tabs
actually detect and show the banner for.


## Fixed: iPhone Add-to-Home-Screen label still said "Havilah"

Found the actual cause rather than guess — iOS Safari has its own
dedicated meta tag for this (apple-mobile-web-app-title), separate
from and taking priority over the web manifest entirely. It was
still set to "Havilah" from before the rename — updated the web
manifest's name/short_name at the time but missed this iOS-specific
one. Fixed it, and matched manifest.webmanifest's short_name too so
Android's home-screen label is consistent with it. Swept the whole
project afterward for any other bare "Havilah" (without "App") in
every HTML/manifest/JSON file, rather than assume this was the only
spot — confirmed clean.


## Recovered Debt: delete button for customer repayments, Admin/GM only

Checked the real current state first — Recovery already had a delete
button, but only for room payments (Reception); regular customer
repayments (OpenBar/MainBar/Minimart/Restaurant) had Edit but no
Delete at all. That was the actual gap.

Also checked RLS before touching anything rather than assume it
matched: a DELETE policy (repay_remove) already existed on
credit_repayments, but was scoped to app_is_editor() — confirmed as
storekeeper/manager/gm/admin, genuinely broader than "Admin and GM
only." Narrowed it to admin/gm specifically, in the same inline style
the table's own UPDATE policy already uses, rather than leave the
database permitting more than what was actually asked for.

App side mirrors the existing room-payment delete exactly — same
confirm-sheet pattern, same shared busy state — with wording specific
to this context (a customer's balance going back up, not a training
disclaimer) since this is for correcting a real mistake, not cleaning
up practice entries.


## Fixed: Credit's Reception tab was silently empty for everyone

Found the real cause rather than accept my own earlier "this already
works" claim once the user reported otherwise — loadGuestBalances
tried to embed stays!inner(...) directly from v_stay_folio. That
embedding mechanism only works when PostgREST can find a real foreign
key to follow, and v_stay_folio is a view — views don't have foreign
keys. This almost certainly broke for every guest, silently, since
Credit.jsx's own .catch(() => setGuestBalances([])) swallowed
whatever error resulted and just showed an empty list with no
indication anything had failed.

Fixed by splitting into two plain queries and merging client-side:
v_stay_folio for the outstanding figures (no embedding, just flat
columns), then stays — a real table, where the embed to rooms/guests
works correctly — for just the matching stay ids. Same safe pattern
loadFolio already uses elsewhere in this codebase for exactly this
reason.

Swept every other view query in the file afterward to check whether
this was a repeated pattern — it wasn't. Every other view (v_debt_
recovery, v_customer_balances_by_staff, v_sale_variances, etc.) was
already designed to expose pre-joined, flat columns directly
(customer_name, location_name, recovered_by_name) rather than lean on
PostgREST relationship embedding, so this was an isolated case, not a
systemic one.


## "Billed to" — a stay's payment responsibility, visible from check-in onward

Built for the common case a long-term guest raised directly: one
guest vouching for a friend/visitor in a separate room, paying at
month-end. Deliberately free text on stays.bill_to rather than a
structured link to another stay — the responsible party isn't always
a hotel guest (a company, a relative not staying here), and a
structured reference would need to handle that other stay being
edited or deleted out from under the link. Free text covers every
real case without that complexity; a structured link can be added
later if a specific need for it shows up.

Explicitly connected this to the exact lesson from the Alphonso/
Obitex naming mess earlier in this build: the guest's own name field
must stay the guest's real name, never "Friend of X" or "Room Y (for
X)" — that's precisely the pattern that fragmented those two into
duplicate, hard-to-reconcile records. "Billed to" is a genuinely
separate field for exactly this purpose, so the relationship is
recorded without corrupting the name.

Confirmed v_occupancy_today's real definition before touching it
(had only ever seen its column list before, never its actual SQL) —
added s.bill_to as the one new column, nothing else changed. Visible
in three places now: the check-in form itself (optional, plain-text,
explained inline), Folio's header as a highlighted badge plus its
edit sheet (can be set or changed anytime during the stay, not just
at check-in), and Room Board's own room cards. Also extended
loadGuestBalances (fixed last turn) to surface it on Credit's
Reception list — the exact place staff would go to see who owes
money, where knowing "this isn't actually their responsibility" is
the whole point.


## Daily Sales: Restaurant room-charges merged in

Same gap as the Sales screen's own Today list, just never carried
over to this page — Restaurant food charged to a room lives in
orders/order_items, never sales, so it never showed here for any
past date either. Reused loadRestaurantRoomCharges (already supports
any date, not just today) and merged it into the same list sales
already populate, sorted together chronologically. Deliberately left
the financial summary above untouched — stays sales-only by design,
same reasoning as the Sales screen.

## Credit: Reception's staff filter now actually filters

Confirmed directly in the code rather than guessed: refreshGuestBalances
was calling loadGuestBalances with only branchId, never passing
staffFilter at all — so picking a specific person while viewing
Reception silently did nothing. Extended loadGuestBalances to accept
a staffId and filter by stays.created_by (who checked the guest in —
the closest real equivalent to served_by/credit_staff_id for a room
stay, since guest balances aren't tied to a "serving staff" the way
customer credit is).

## Credit and Recovery: "Restaurant tab missing details" — confirmed
## not a bug

Checked both underlying views' real definitions before assuming
anything was broken (v_customer_balances_by_staff,
v_debt_recovery) — both are structurally sound, plain flat columns,
no embedding issues like the one that broke Reception's guest
balances earlier. Then checked directly whether any credit sale or
repayment actually exists at Restaurant on either branch — zero rows,
confirmed. The empty list is correct; there's simply no data there
yet. No code changes made here, since there was nothing to fix.

## Rooms: out-of-service activated

Confirmed set_room_service_status's real body before building against
it — already enforces can_manage_rooms() (manager and up) at the
database level, and already refuses to take an occupied room out of
service, naming the guest specifically. Built the app side to match
exactly: "Mark out of service" (with an optional reason) only offered
on vacant rooms, gated to manager/gm/admin; "Back in service" on rooms
already marked out. The room-has-a-guest and permission checks are
the database's own enforcement, not just UI hiding.


## Correction: Staff order type is actually paid, not a write-off

Original design treated "Staff" identically to "PR/Damage" — a
direct-save write-off with no payment at all. Per explicit
correction, staff meals genuinely are paid for; only PR/Damage is a
true write-off with nothing collected. Standard and Staff should
behave identically for payment purposes, differing only in the
order_type tag kept for reporting.

App side: both SalesEntry's "Add a restaurant order" sheet and
RoomChargeSheet's typed-order path now branch on
order_type !== 'pr_damage' (not === 'standard') to decide basket vs
write-off — so Staff now goes through the exact same POS/Cash/Credit/
Split flow as Standard. Threaded order_type and writeoff_note through
addTypedOrder, saveBasket, chargeItemToRoom, and the offline-outbox
payload, none of which previously had any way to carry a Staff tag
through the normal payment path at all.

Found and fixed the same display bug in three separate places
(SalesEntry's Today list, Folio's order lines) — each was checking
"is this NOT standard" to decide whether to show "not paid for" and
skip the real payment summary, which was correct for PR/Damage but
wrong for Staff now that it has genuine payment info. Narrowed each
to check specifically for pr_damage instead.

Database side: narrowed every exclusion built when Staff was
originally (incorrectly) treated as a write-off — get_daily_
financials' gross sales and nonRevenue bucket, v_sale_variances, and
v_stay_folio's orders_charge — from "anything non-standard" to
specifically "pr_damage only". Staff orders now correctly count as
real gross sales, can show up as a genuine variance if underpaid, and
correctly bill a guest's room if charged there.

Swept the whole codebase afterward for any remaining
order_type === 'standard' / !== 'standard' comparison tied to this
logic — none found, confirming the fix is complete rather than
partial.


## Charge-to-room visibility generalized to every department

Confirmed the gap directly rather than assumed: loadRestaurantRoomCharges
was hardcoded to category='food', wired only into Restaurant's branch
of both SalesEntry and DailySales. A minimart item or a bar drink
charged to a room never showed on its own department's sales list at
all — only Restaurant had this. Generalized into loadRoomCharges(branchId,
date, category), mapping whichever department is actually selected to
its matching category (food/minimart/drink), with loadRestaurantRoomCharges
kept as a thin backward-compatible alias. Same merge/render logic as
before, now driven by roomChargeCategory instead of an isRestaurant-only
check.


## Guest deduplication — both pieces built

Preventive: CheckIn now debounce-searches existing guests as the name
field is typed (plain ILIKE substring match — this app's guest list
is small enough that real fuzzy matching isn't needed, and a simple
substring reliably catches shared-prefix misspellings like Alphonso/
Alphonsus in practice). Tapping a suggestion pre-fills name/phone to
match exactly, so findOrCreateGuest's existing matching naturally
reuses that same guest rather than creating a new one. A nudge, not a
hard block — staff can still dismiss and proceed if it's genuinely a
different person.

Retroactive: a new merge_guests() RPC, gated to is_supervisor()
(gm/admin only — the strictest tier already used elsewhere in this
app, given how hard this is to undo if the wrong two guests get
merged). Reassigns every stay from one or more duplicates onto a
chosen survivor, then marks the duplicate record clearly rather than
deleting it outright, so the merge stays reversible-by-inspection
even though the RPC itself doesn't undo. App side: MergeGuestsSheet,
a new two-step component (pick survivor, then pick duplicates, each
step showing stay counts so staff can tell which record actually has
the real history), reached from a new "Guest records" section on
StaySettings, same gm/admin gate.


## Fixed: print/PDF had ~half an A4 page blank before content

Traced the real cause rather than guess — every sheet/modal in this
app (Folio, Receipt, FolioStatement, etc.) is a position:fixed
wrapper. .invoice-print's own CSS was already explicitly set to
position:absolute; inset:0 auto auto 0 to pin it to the page's top-
left, but absolute positioning resolves against the nearest
POSITIONED ancestor — and that fixed wrapper was it, not the actual
page. position:fixed during print is a well-documented source of
exactly this kind of blank-space/offset bug across browsers.

Fixed by neutralizing position:fixed on every wrapper specifically
during print (.fixed { position: static !important }), so
.invoice-print's absolute positioning correctly resolves against the
page instead. Confirmed this has no visual side effects — everything
under those wrappers is already visibility:hidden during print, so
changing their positioning doesn't make anything newly visible, it
only fixes the containing-block chain. Confirmed Receipt.jsx shares
the identical fixed-wrapper structure, so this was very likely
affecting receipt printing too, not just guest statements — one
shared fix covers both rather than patching FolioStatement alone.


## Option B: the workaround customer-credit system linked to real guests

Built now that guest dedup is confirmed solid — linking to guests
(customers.linked_guest_id), not a specific stay, so the connection
survives checkout and any future re-checkin rather than expiring the
moment a stay closes.

New view v_guest_department_credit consolidates a linked customer's
balance per department, summed across any staff_id split (the same
kind of split that briefly happened during the Alphonso
reconciliation) into one clean total per department per guest.

Linking UI: a "Link to a guest" action on Credit's customer statement
sheet, reusing the same debounced name search built for check-in's
similar-guest suggestions. Display: threaded through loadFolio (one
extra query, not duplicated per consumer) into Folio itself, the
printable FolioStatement, and Credit's Reception guest-balance list —
the three places a guest's real total actually matters. Always shown
as a clearly separate figure, explicitly labeled as not part of the
room bill — a room charge and department credit settle through
completely different mechanisms (room payments vs credit_repayments),
and folding them into one number would be misleading for
reconciliation even though they're genuinely the same person's debt.


## Invoice: Outstanding balance now genuinely includes linked department credit

Reverses my earlier deliberate design choice (keeping room and
department debt as separate, clearly-excluded figures) per explicit
correction. The headline "Outstanding"/"Balance due" figure on Folio,
FolioStatement, and Credit's Reception list now includes linked
department credit, with the per-department breakdown still shown
underneath (now labeled "Included above" rather than "not part of
the room bill"). Room-specific mechanics stay untouched on purpose —
the Pay sheet's default amount and checkout logic still use the
room's own balance alone, since a room payment genuinely can't settle
a separate department's credit ledger; only the display total changed.

Also closed a deeper gap found while fixing this: a guest whose room
was fully paid but who still owed at another department would
previously vanish from Credit's Reception list entirely, since the
underlying query only ever started from stays with an outstanding
room balance. loadGuestBalances now also surfaces guests who owe
*only* department credit, using their most recent stay for display.
Sort order now reflects the combined total too.

Added branch_id as a plain column on v_guest_department_credit rather
than embedding guests from it — the exact view-embedding trap that
broke this function once already (views have no foreign keys for
PostgREST to follow).

## Restaurant: PR dropdown now has meal options (Breakfast/Lunch/Dinner)

New, genuinely separate pr_meal column on sales and order_items —
deliberately not reusing damage_reason, since a value like
'breakfast' isn't a damage reason and would corrupt any future
reporting that counts damage incidents by reason. Shown as its own
dropdown, specifically when "Not damage — PR only" is selected, in
both entry points (SalesEntry's walk-in restaurant orders and
RoomChargeSheet's room-charged ones). Threaded through
saveRestaurantWriteoff/chargeWriteoffToRoom and every place damage_
reason is displayed (Today list, Folio's order lines) — confirmed all
three underlying select queries actually fetch the new column, not
just that the display code was updated to show it.


## Bill To now editable on checked-out stays, not just live ones

Found while doing a real retroactive bill-to assignment: the "Edit
rate, cycle, or dates" button (which is also where bill_to lives) was
gated to live stays only, so a checked-out stay couldn't have bill_to
set at all through the normal screen — exactly the situation that
came up. Removed that gate for this one button specifically; the
other three live-only actions on Folio (record payment, checkout,
etc.) stay exactly as they were, since those genuinely don't make
sense on an already-closed stay.


## Bill To: now a real structural link, not just a display badge

Explained the actual gap when asked why Anthony's bill wasn't showing
on Alphonso's own folio: bill_to was always one-way, free-text-only —
it annotated the stay being paid for, but nothing pulled that amount
back into the payer's own totals. Different from Option B's
department-credit link, which does have a real foreign key behind it.

Added stays.bill_to_guest_id as an OPTIONAL structured link alongside
the existing free text — when the payer is an actual guest, this
becomes real and queryable; when it's a company or someone not
staying here, free text is still all there is, exactly as originally
designed. Both CheckIn and Folio's edit sheet now search existing
guests as "Bill to" is typed (same debounced pattern as the
similar-guest suggestions), linking both the text and the structured
id together when a suggestion is picked.

loadFolio now also fetches loadBilledToYou() — other stays whose
bill_to_guest_id points at this guest, with a real outstanding
balance. Threaded through Folio, FolioStatement, and Credit's guest
statement the same way departmentCredit already was: included in the
headline Outstanding total, with its own separate detail box showing
which guest/room each amount belongs to.

Also extended loadGuestBalances (Credit's Reception list) to include
billedToYou per guest, same as it already did for department credit —
this is the list staff actually check first, so it needed the same
full-picture treatment rather than leaving this only visible on a
folio someone has to think to open. A guest who owes nothing on their
own room but has bills assigned to them from elsewhere now correctly
appears here too, using their most recent stay for display.

Linked Anthony's specific stay to Alphonso's real guest_id (migration
181), looked up from his known current stay rather than assumed —
the structural piece that makes this specific case actually work end
to end, on top of the text label already set in 179.


## Fixed: a real, widespread regression from adding bill_to_guest_id

Traced "Recently checked out shows no results" to its actual root
cause rather than patching the symptom. Adding stays.bill_to_guest_id
(for the Bill To structural link) gave stays TWO separate foreign
keys to guests — guest_id and bill_to_guest_id — confirmed directly
against pg_constraint, not assumed. Every plain guests(...) embed
from stays became ambiguous to PostgREST the moment that second FK
existed, since it had no way to know which relationship to follow.
ReopenSearch's .catch(() => setRows([])) silently swallowed the
resulting error and showed "no results" instead — genuinely
indistinguishable from an empty result without checking the error
directly, which is why the raw data (confirmed to exist, plenty of
recent checkouts on both branches) didn't match what the app showed.

Found and fixed eight separate broken embeds in data.js — not just
ReopenSearch, but loadBilledToYou, loadGuestBalances (both its main
query and its extra-guests query), loadReceptionActivity,
loadRoomPayments, loadRoomCharges, and a stays search function — all
now explicitly disambiguated to guests!guest_id(...), since all of
them want the stay's actual occupant, never the bill-to party. Found
a second instance of the same regression in the reverse direction too
— searchGuestsForMerge embeds stays(count) FROM guests, which is
ambiguous for the identical reason (both FKs point at guests, so
counting "this guest's stays" doesn't know which relationship to
use); fixed to stays!guest_id(count).

Also fixed the silent error-swallowing in ReopenSearch specifically,
since this whole bug was invisible only because the real error never
surfaced — it now shows a toast with the actual error message instead
of quietly presenting an empty list as if it were a genuine zero
result.


## PR/Damage backdating fixed — Restaurant and room-charged versions

Confirmed the actual gap before assuming scope: the REGULAR stock-item
PR/Damage writeoff sheet (Minimart/OpenBar/MainBar, via Store.jsx and
SalesEntry's own writeoff sheet) already had its own date picker and
correctly supported backdating — that part was never broken. The gap
was specifically the newer typed-order sheets built later: Restaurant's
"Add a restaurant order" (SalesEntry.jsx) and its room-charged
equivalent (RoomChargeSheet.jsx) both hardcoded businessDate: lagosToday(),
so a PR/Damage entry always posted today regardless of when it actually
happened.

Fixed both with the same Date field the existing writeoff sheet
already uses, scoped specifically to the PR/Damage path in each —
Standard and Staff orders go through the basket (SalesEntry) or the
paid charge-to-room path (RoomChargeSheet), both of which already
have their own separate date handling, so they didn't need this.

Checked every other hardcoded lagosToday() used as a save-date across
the whole codebase rather than stopping at the two reported spots.
Found two more, in Folio.jsx and Credit.jsx — both are recordStayPayment
(room payments), a genuinely different category from PR/Damage: real
money received in the moment, not administrative record-keeping
entered after the fact. Left these as-is since they're outside what
was reported, but flagging them as a real, separate thing worth a
decision if backdating a room payment is ever a genuine need.


## Navigation restructure: bottom tabs promoted for GM/Admin/Manager, department chips reordered

Bottom tabs: oversight roles (manager/gm/admin) now get Daily Sales,
Rooms, Credit, More as their four direct tabs — their genuinely
load-bearing, cross-department screens — with Sales, Store, and Stock
moved into More for them specifically. Storekeeper and every other
department-scoped role keep their existing direct tabs unchanged;
this only restructures the three oversight roles.

Replaced the old hardcoded per-role exclusion list on the More-tab
highlighting logic (which needed a new line added by hand every time
a role's direct tabs changed) with one derived from the tabs array
itself — More only highlights for a key that isn't already that
role's own direct tab, computed automatically rather than maintained
by hand. Confirmed App.jsx's tab routing is purely key-based, not
role-based, so no changes were needed there — Sales/Store/Stock render
identically whether reached via a direct tab or through More.

Department chips (the top tabs): confirmed Store/Housekeeping/Others
are is_sales_point=false and never show as chips regardless of sort
order, so only the five real sales-point locations per branch needed
reordering. Awka: Reception, OpenBar, Restaurant, Minimart, MainBar.
Nnewi: Reception, OpenBar, Restaurant, Minimart, Lounge. This is a
sort_order change (migration 197), so it applies universally — same
order for every role who sees these chips, department-scoped staff
included.


## PR billing cycle now actually free

'pr' already existed as a valid billing_cycle value, but v_stay_folio
never treated it specially — it still computed room_charge = daily_
rate * nights like any other cycle, exactly the bug reported. Found
the specific guest before assuming: "Owner of Havila", Room Suite,
Awka, showing ₦150,000 outstanding despite billing_cycle = pr.

Fixed at the view level, scoped specifically to room_charge — orders_
charge (food/drinks) and overstay_charge (a penalty for a different
behavior) stay untouched, since PR governs the room rate itself, not
every possible charge on the stay. Because v_stay_folio is computed
live, this guest's balance corrects automatically the moment the
migration runs — no separate data patch needed on top of the view fix.

Also relabeled the cycle picker from bare "PR" to "PR (free)", since
the whole bug was ambiguity about what selecting it actually meant.


## More menu reordered for GM/Admin/Manager

Sales/Store/Stock moved to right after Recovered debt in the shared
ITEMS array: Recovered debt, Sales, Store, Stock, Stock count,
Catalog, Variances, Corrections, Settings. Confirmed before making
this change that it only actually affects oversight roles — every
other role that sees this menu (storekeeper, bar, front_desk,
auditor) either doesn't have access to Sales/Store/Stock in More at
all (storekeeper has them as its own direct tabs) or never did, so
moving those three items' position in the shared array has no visible
effect for them. Confirmed explicitly with the user that Catalog
stays GM/admin only rather than extending it to Manager, so Manager's
own list correctly skips it while GM/admin's includes it — same
shared order, each role's own access still governs what actually shows.


## Fixed: landing tab on sign-in now correct for every role, not just oversight

Root cause: tab's initial state was hardcoded useState('sales'), a
leftover from before oversight roles had their own separate tab
structure — for manager/gm/admin, 'sales' isn't even one of their
direct tabs anymore, so the bottom nav landed on "More" as the
highlighted item instead of their actual primary screen (Daily Sales).

Fixed with a role-aware effect that sets the correct starting tab
once identity is actually known, verified against Shell.jsx's real
tab-building logic for the complete, confirmed set of seven roles
(front_desk, bar, storekeeper, manager, gm, admin, auditor) — not
assumed from memory. Every role now lands on its own genuine first
tab: Sales for front_desk/bar/storekeeper, Daily Sales for manager/
gm/admin/auditor.

Guarded with a ref so this only ever applies once, on the actual
first sign-in — identity gets a new object reference on every auth
token refresh too, and without the guard this would have yanked
anyone back to their default tab mid-session every time that
happens, not just on a genuine fresh sign-in. Also resets that guard
specifically on sign-out, so a different role signing in on the same
device without a full page reload still gets correctly landed on
their own tab, not whatever the previous person was last on.


## Reception: default department fixed, plus a new close-of-day dashboard

Confirmed the actual root cause before fixing rather than trusting the
attributed one: default_location_id was explicitly set to Minimart
for every front_desk account at both branches, predating the recent
chip reordering entirely (that column takes priority over sort_order,
so reordering the chips was never going to change this). Corrected to
Reception for every front_desk account at both branches.

New Reception dashboard, shown above the existing activity list:
POS/Cash/Credit summary for today, a full breakdown of what's
deferred (confirmed with the user this means the complete current
outstanding across every live Reception stay, not just today's
accrual — reuses loadGuestBalances, including its department-credit
and other-bills totals from the recent Outstanding fix), and a
breakdown of advance payments — guests who've paid ahead of what they
currently owe, showing how much of that advance has been used up by
charges so far versus what's genuinely still left as a credit.


## Advance payments dashboard: restricted to live stays only

Per explicit correction — loadAdvancePayments had no status filter at
all, so an old overpayment sitting on an already-checked-out stay
would show up alongside genuinely current advance balances. Now
restricted to occupied/reserved stays specifically.


## Rooms: reservations no longer block the room until they're actually due

Real architectural change, built carefully given the risk of a
constraint change around double-booking. Replaced stays_one_live_per_
room (a simple "at most one live stay per room, ever" unique index,
with zero awareness of dates) with a date-range-aware exclusion
constraint (stays_no_date_overlap, requires btree_gist). A future
reservation now only blocks its own actual date range — the room
stays bookable for any nights before that.

Occupied stays deliberately get an UNBOUNDED upper range rather than
using scheduled_out as the boundary — an overstaying guest must keep
blocking the room indefinitely until they actually check out, and
CURRENT_DATE can't be used inside a constraint at all (constraints
must be immutable expressions). Reserved stays get a bounded range
(check_in_date to scheduled_out), since a reservation's whole point
is to only block its own planned window. Confirmed this migration is
safe to apply to existing data without any risk of failing: the old
constraint was strictly tighter than the new one, so every existing
row already satisfies the looser rule automatically.

App side: loadFreeRooms rewritten to accept the actually-requested
check-in/scheduled-out dates and check for real overlap (mirroring the
DB constraint's own logic in JS), rather than "is there any live stay
on this room at all." CheckIn now re-fetches availability whenever
either date changes, and clears a previously-picked room if it's no
longer free for the newly-selected dates rather than letting a stale
selection through.

The reminder half: Room Board now distinguishes a reservation whose
date has actually arrived (or passed) from one still weeks away — a
new "Reserved — due" state, shown as a clear per-room badge on the
card itself, plus a prominent banner at the top of the page listing
every room due today by name, so it can't be missed by someone
quickly scanning the board.


## Daily Sales: Reception now shows the same deferred/advance breakdown

Checked Alphonso and Obitex's real, current numbers directly rather
than trust stale memory — both genuinely have positive outstanding
right now (₦9,500 and ₦30,000), so they'd have correctly appeared in
the dashboard's Deferred list. The actual gap was that this dashboard
only ever existed on the live Sales screen (SalesEntry.jsx) — Daily
Sales (the separate page for browsing any past day) never got it at
all, and its Reception view only ever showed payments actually made
on the selected date. A long-term guest who isn't paying daily simply
never appears on a payments-only list, no matter how much they owe.

Extended with the same loadReceptionDashboard data, deliberately
scoped to only show when the selected date is actually today —
v_stay_folio's outstanding is always a CURRENT balance, not a
historical snapshot for a given past day, so showing it against, say,
last Tuesday would misrepresent what was actually owed back then. A
plain note explains this when a past date is selected instead of
silently showing nothing. Branch-scoped by staff.branch_id like
everything else in this app, so this is already correct for GM/admin
switching between Awka and Nnewi without any special handling needed.


## Fixed: a real design flaw in the date-aware room availability constraint

The constraint from last turn was correctly built and deployed, but
gave occupied stays an unbounded upper range specifically to handle
overstays safely — meaning any new check-in today was treated as
potentially lasting forever, which then always conflicted with any
future reservation on the same room. Confirmed directly against the
live constraint definition before concluding this, not assumed —
reproduced exactly the reported symptom (a reservation for the 30th
blocking a check-in today) by tracing through the actual logic.

Corrected: both reserved and occupied stays now use their real
scheduled_out as the boundary — a planned window, not an infinite
one. The overstay case moved to the app side instead
(loadFreeRooms), which can compare against today dynamically; an
occupied stay whose scheduled_out has already passed still blocks at
least through today even though its stored value says otherwise —
something a database constraint fundamentally can't do, since it
can't reference the current date at all. Confirmed this correction is
still safe against existing data for the same reason the original
migration was: strictly looser than what's currently active, so
nothing existing can violate it.


## New: "Move to room charge" tool for the workaround credit system

Built because this kept recurring throughout this project — a real
purchase recorded through the workaround customer-credit system
instead of the proper "Charge to a Room" feature, leaving it stuck
in the wrong ledger. Verified this wasn't a code bug before building
anything: chargeItemToRoom and Folio's display both already work
correctly for every department, confirmed directly against real data
(minimart and bar room-charges already exist and display fine) — the
actual gap was purely that these specific purchases were never
recorded the proper way in the first place.

New RPC (move_workaround_credit_to_room), gated to is_supervisor()
matching merge_guests — this permanently moves real money between two
ledgers. Requires the customer already be linked to a guest and that
guest have a live stay; creates a real order_items charge on that
stay and zeros the workaround balance via credit_repayments, correctly
handling a balance split across multiple staff-attribution rows (same
lesson learned from the earlier Alphonso/Chef mismatch) — one
repayment per staff_id, not a single lump sum that could land under
the wrong person's ledger. New button on Credit's customer statement,
gated the same way, with a confirm step given the stakes.

Also linked Alphonso's workaround customer record to his real guest
identity — it was never linked at all, unlike Obitex's, confirmed
directly rather than assumed, which meant his balance wasn't even
visible on his folio before this.


## Recovered Debt: room payments now show stay context

Extended loadRoomPayments to pull check_in_date/scheduled_out/actual_out
alongside what it already had. Each room payment on Recovery's
Reception tab now shows the stay's start date and how many nights,
computed the same way v_stay_folio itself does (through actual_out,
scheduled_out, or today, in that priority).

## Credit: guest statement now shows date and department per charge

li.date and li.category were already present in the data flowing
through Folio and FolioStatement — they just weren't being displayed.
The itemized charges table (reached via a guest's payment sheet →
"Print guest statement", already existing) now shows a Date column
and which department each order line came from, alongside what it
already had (item, quantity, amount).


## Sales: the 12PM credit deadline rule

A credit sale only counts toward that day's gross sales / daily sales
figure if the customer has SOME repayment activity recorded between
the sale and noon the following day (Lagos time) — confirmed with the
user this doesn't need to be the full amount. If nothing is recorded
by the deadline, the sale is pulled out of that day's gross sales and
counted purely as credit instead. Confirmed this is a live,
dynamically re-evaluated rule, not a one-time snapshot taken at the
time of sale — get_daily_financials reflects the current state of
repayments whenever it's called, for any date, so a sale can move
categories after the fact as repayment activity does or doesn't
happen.

Checked credit_repayments.sale_id before relying on it for precise
matching — it exists as a column but saveRepayment never populates
it, always null in practice. Used "any repayment for this customer
between the sale's own timestamp and the deadline" instead, the most
defensible proxy the schema actually supports given repayments aren't
linked to specific sales. Noon cutoff built using Lagos time
specifically (AT TIME ZONE 'Africa/Lagos'), matching this app's
existing business_date convention, not UTC noon.

Surfaced the new unqualifiedCredit figure on both the Sales screen's
own daily summary and Daily Sales — a genuinely new, separate line
under Credit raised, not a sub-item of it (gross sales is already net
of this amount before credit raised gets computed, so mislabeling it
as "included in credit raised" would have been actively wrong).


## Reception dashboard: yesterday's snapshot

New collapsible "Show yesterday's snapshot" toggle below the advance-
payments section — lazy-loaded, only fetched once actually expanded,
not on every page load. Reuses loadDailyFinancials and loadReceptionActivity
for the prior day (both already supported arbitrary dates), showing
POS/Cash/Credit raised plus the actual list of payments collected that
day. Deliberately doesn't include deferred/advance figures for
yesterday — those are always current-moment balances (v_stay_folio has
no historical snapshot capability), so showing "yesterday's" deferred
would just be today's number mislabeled.


## Folio: room-rate period countdown

For any occupied stay booked more than one night, the Folio now shows
a progress bar under Outstanding: nights used vs nights left, and how
much of the room rate has been "taken out" so far vs how much remains,
purely time-based against the planned check-in→scheduled-out window.
Deliberately independent of payment status — it tracks the room rate's
own consumption of the booked period, not whether it's been paid for
or whether other departments have added extra charges on top (see
Alphonso: room rate is fully covered by his advance regardless of the
separate ₦9,500 he owes for food/drinks — those are different things).


## Reception dashboard: in-house roster (closes the "look checked out" gap)

loadReceptionDashboard now also returns `inHouse` — every currently
occupied room (from v_occupancy_today), each tagged 'paid' (had a
payment today), 'credit' (owes and paid nothing today), or 'settled'
(zero balance, no activity today — e.g. a monthly-advance guest
mid-stay). Rendered on both SalesEntry.jsx and DailySales.jsx, right
after Advance payments.

The gap this closes: Deferred only lists guests with outstanding > 0
and Advances only those with outstanding < 0, so a guest sitting at
exactly zero — fully settled, nothing new charged or paid today —
fell through both lists and had zero footprint on the dashboard,
indistinguishable from having checked out. The in-house roster is
built from actual occupancy (v_occupancy_today, status='occupied'),
not from transaction activity, so every occupied room shows up
regardless of whether money moved for it today.

Scoped to today only, same as Deferred/Advances — v_occupancy_today
is current-moment, no historical snapshot for past dates.


## Reception dashboard: Advance payments replaced with Room rate — period progress

Swapped the "Advance payments — balance remaining" section on both
SalesEntry.jsx and DailySales.jsx for "Room rate — period progress" —
the same countdown concept built for the single-guest Folio, now shown
across every occupied, multi-night stay at once. Per guest: a mini
progress bar, nights used/left, and how much of the room rate has been
taken out vs remains against the scheduled-out date. Headline figure
is the total still "left" across all such stays.

New loadRoomRateProgress() in data.js (v_stay_folio, status='occupied',
nights > 1) replaces the loadAdvancePayments() call inside
loadReceptionDashboard — loadAdvancePayments() itself is left intact
and exported, just no longer wired into this particular dashboard.
Same deliberate independence from payment status as the Folio version:
this tracks the room rate's own consumption of the booked period, not
whether it's been paid for.


## Staff of the Month

New company-wide banner (not branch-scoped — one ₦10,000 grand-prize
winner recognized at both branches). Shows automatically for 7 days
after being posted, then disappears on its own — the row stays in the
table as history, the app just stops rendering it once posted_at is
more than a week old.

- Migration 221_staff_of_month.sql: `staff_of_month` table (readable
  by everyone, writable only by GM/admin via is_supervisor()) and a
  public `staff-photos` storage bucket with the same write
  restriction, for the optional photo.
- data.js: loadStaffOfMonth() (latest row + isActive/daysSince),
  postStaffOfMonth() — a same-day edit updates the existing row in
  place (fixing a typo doesn't reset the clock), but posting on a new
  day always creates a fresh row, which is what actually restarts the
  7-day window.
- StaffOfMonthBanner.jsx, wired into Shell.jsx right alongside the
  existing PendingBanner/UpdateBanner — shows on every screen, any
  role, either branch.
- Settings (StaySettings.jsx): new GM/admin-only section — name field,
  optional photo upload/remove, live status ("3 days left" / "expired").

Run the migration in Supabase before deploying the app build, or the
banner and Settings section will error on load (table doesn't exist yet).

## Room rate progress: GM Office hidden from non-GM/admin, rooms-sold count added

Found that "GM Office" is an existing internal placeholder stay on
room 209 — check-in 2026-07-01 through 2027-05-20, ₦0 daily rate —
used to block the room for internal use, not a real guest. Two
changes to the "Room rate — period progress" section on both
SalesEntry.jsx and DailySales.jsx, GM/admin gating matching
is_supervisor()'s own role set:

- Room 209 is filtered out of the list (and its 0-contribution
  excluded from the running total) for every role except gm/admin.
  Everywhere else in the app (Room Board, In-house roster) is
  untouched — this was scoped narrowly to just this one section, per
  the request.
- New "X rooms sold this month" line, GM/admin only, from
  loadRoomsSoldInMonth(branchId, date) — counts bookings by check-in
  date within whichever calendar month the browsed date falls in
  (capped at today if it's the current, still-ongoing month; the full
  month if browsing a past one), excluding room 209 itself so the
  count reflects real guest bookings. On SalesEntry.jsx (always today)
  this reads as "this month so far"; on DailySales.jsx it also works
  correctly when browsing back to a fully-past month, and is placed
  outside the today-only receptionDashboard gate so it still shows
  when browsing history — deferred/advance/in-house genuinely have no
  historical snapshot, but a rooms-sold count is a real historical
  count and works for any date.


## Correction: Staff of the Month is per branch, not company-wide

Reversed the earlier assumption. Each branch now recognizes its own
₦10,000 winner independently — Awka and Nnewi each have their own
current post, their own 7-day clock, and their own history.

Migration 222_staff_of_month_per_branch.sql (run after 221, or
instead of it if 221 hasn't been applied yet): adds a required
branch_id column, and rewrites the select policy so a regular staff
member only sees their own branch's post while GM/admin (via
is_supervisor()) can see any branch's — matching how they already
view either branch elsewhere in the app.

loadStaffOfMonth(branchId) and postStaffOfMonth({ branchId, ... }) are
now branch-scoped throughout — the "is there already a post today"
check that decides same-day-edit vs fresh-post is scoped per branch
too, so one branch posting today doesn't affect the other's. Uploaded
photos are now stored under a branchId-prefixed path in the bucket,
just to keep them organized per branch (not a security boundary —
the bucket's RLS already restricts writes to GM/admin regardless).

StaffOfMonthBanner now takes a branchId prop (Shell passes
staff.branch_id, which already reflects whichever branch is currently
being viewed — the same value every other branch-scoped screen in
this app already relies on, including GM/admin's branch switcher).
Settings reloads the form when the viewed branch changes, so GM/admin
switching branches sees that branch's own winner, not stale data from
the one they just left.


## Fix: "Cannot access before initialization" crash on load

Real bug, not cosmetic — SalesEntry.jsx declared visibleRoomRateProgress
(and its total) using receptionDashboard several lines before
receptionDashboard's own `useState(null)` call executed further down
in the same function body. That's a temporal dead zone violation:
referencing a const/let before its declaration line runs throws at
render time, and since Shell renders unconditionally on every screen
and Sales is most roles' landing tab, this crashed the entire app on
load for anyone hitting that code path — dev server didn't catch it
because the exact function-body ordering that triggers a TDZ error
doesn't always surface as a build-time warning.

Moved the isGmOrAdmin/visibleRoomRateProgress/visibleRoomRateRemainingTotal
block to right after the receptionDashboard state declaration instead
of near the top of the component. Checked every other file touched
this session (Folio.jsx, DailySales.jsx, StaySettings.jsx, Shell.jsx,
StaffOfMonthBanner.jsx) for the same pattern — DailySales.jsx already
had the correct ordering, the rest never referenced a not-yet-declared
value at all.


## Staff of the Month: delete a post

Added deleteStaffOfMonth(id) in data.js — a straight delete, RLS
already restricted to GM/admin (is_supervisor()) from migration 221,
untouched by 222's per-branch correction.

Settings shows "Delete this post" next to the current post's status
(live or expired), with an inline confirm/cancel step before it
actually deletes — same two-step pattern already used elsewhere in
this app (Folio's booking delete, Shell's sign-out). Deleting clears
the local form too, so a leftover "test" name doesn't sit in the input
waiting to be accidentally re-posted. Once deleted, that branch's
banner goes back to showing nothing until a new one is posted.


## Appearance: bottom nav redesigned (glass, floating, WhatsApp-style)

Replaced the old full-width, opaque bottom bar with a floating pill:
inset from the screen edges (bottom-3, inset-3), rounded corners,
backdrop-blur-xl + backdrop-saturate-150 over a semi-transparent
surface color, a faint white border for the glass edge highlight, and
a soft drop shadow for lift — the "liquid glass" look. Functionally,
each tab now has an icon above its label (six small hand-written SVGs
in new NavIcon.jsx — no icon library added for just six glyphs), and
the active tab gets a rounded pill highlight behind it rather than
just a color change, matching the newer WhatsApp/Material 3 bottom-nav
pattern. The "More" badge count still works, repositioned to sit over
the icon instead of the old text label.

No new dependency, no migration — purely CSS/markup in Shell.jsx plus
the new NavIcon.jsx.

## Staff of the Month: prize amount is now editable

Migration 223_staff_of_month_prize_amount.sql adds a prize_amount
column (numeric, defaults to 10000) to staff_of_month. Stored per
post rather than as a standing branch setting, so if the prize amount
ever changes, older posts keep showing what was actually paid at the
time rather than being silently rewritten.

- loadStaffOfMonth()/postStaffOfMonth() in data.js both carry
  prize_amount/prizeAmount through now.
- StaffOfMonthBanner.jsx shows naira(entry.prize_amount) instead of
  the old hardcoded "₦10,000".
- Settings: new "Prize amount (₦)" field next to the name field,
  digits-only input, defaults to 10000 for a fresh post and prefills
  from the current post when editing. Posting is blocked if it's
  empty, same as the name field.


## Fix: Daily Sales date input was stretched full-width

DailySales.jsx's date input had `w-full`, which SalesEntry.jsx's
equivalent never had — that one just sizes to content. Dropped
`w-full` so Daily Sales now matches Sales' compact, natural width.


## All date inputs normalized to the same compact width

Found seven more date inputs still using w-full, beyond the Daily
Sales one already fixed: RoomChargeSheet.jsx (backdated pr_damage
entry), Folio.jsx (scheduled check-out edit), Store.jsx (receive/
transfer date), Counts.jsx (new count date), Credit.jsx (repayment
date received), and both of CheckIn.jsx's fields (check-in date,
scheduled check-out). Removed w-full from every one so they all size
to content like Sales' date field does, including the two spots where
a date sits in a side-by-side flex-1 column with a sibling field
(CheckIn's pair, Store's date+receiver row) — the sibling still fills
its column, only the date itself is now compact, since the ask was
specifically about date-width consistency, not the layout around it.
Also added the missing `tnum` (tabular figures) to Credit.jsx's date
input, which every other one already had.


## Fix: GM/admin branch switch didn't reset department filters everywhere

Audited every page with a per-branch department/location selector for
the reset-on-branch-switch pattern already used correctly in
SalesEntry.jsx, Recovery.jsx, and Credit.jsx. Found two that lacked it:

- DailySales.jsx: locId stayed on whatever department was selected on
  the old branch instead of returning to "All departments" — the bug
  actually reported. Added a useEffect that resets it to 'all' on
  every staff.branch_id change.
- Store.jsx: toDept, fromDept, and convertLoc were only ever set once,
  from the initial departments[0]/departments[1] at first render —
  switching branches left them pointing at department ids from the
  old branch, which could point a stock transfer or conversion at a
  department that doesn't exist on the branch now being viewed. Added
  a useEffect validating all three against the current departments
  list on every branch switch, resetting any that no longer match —
  same pattern the other three pages already used.

No other page had a per-branch selector state without this protection.


## Visibility audit: Daniel not seeing Obitex's MainBar credit

Root cause: on Credit.jsx, the aggregate "Guest balances" view (which
already sums a guest's debt across EVERY department, including
MainBar) was only loaded and shown when the currently-selected
department chip happened to be "Reception" — gated on isReception (a
transient UI state), not on whether the viewer actually has Reception
access (a role/assignment fact). Daniel has Reception in his own
location list (Minimart+Reception), so if he had Minimart selected
when he checked, the entire cross-department guest-balances section —
including Obitex's ₦3,000 MainBar debt — simply disappeared, with no
indication anything was hidden.

Fixed by replacing the isReception gate with a proper
hasReceptionAccess check (seesAllDepartments, or Reception present in
the viewer's own locations), and by no longer making the per-
department "Owed to X" list and the guest-balances section mutually
exclusive — both now show together, so switching chips never hides
guest-level debt for someone who's entitled to see it.

Audited every other page with a similar department-chip pattern for
the same class of bug and found three more instances:

- Recovery.jsx: identical isReception-gates-a-cross-department-view
  bug on room-payment recovery. Same fix applied. Also found this page
  was entirely missing the seesAllDepartments expansion that Credit.jsx
  already had — a manager/gm/admin/auditor without an explicit
  staff_locations row covering every department would have had an
  incomplete department-chip list here, same root cause as Credit.jsx
  was deliberately fixed against before. Added it, matching Credit.jsx's
  role set exactly (storekeeper/manager/gm/admin/auditor see every
  department; bar/front_desk stay scoped to their own).
- DailySales.jsx: same missing-expansion gap. Every role that can even
  reach this page (auditor/storekeeper/manager/gm/admin, per its own
  comment: "browse any past day's sales by department") is there
  specifically for cross-department oversight, so it now always uses
  allLocations rather than the viewer's own locations — there's no
  bar/front_desk access to this page that would need staying
  restricted.
- SalesEntry.jsx: manager/gm/admin reach this page via More's "Record
  a sale for any department" — that's the literal product intent, so
  they now see every department as an option. Bar/front_desk/
  storekeeper, who use this page as their direct working tab, are
  unaffected — still scoped to their own assigned department(s).

Store.jsx and Counts.jsx were already correct (Store.jsx uses
allLocations for everyone, appropriate since stock transfers need
every department as a possible source/destination regardless of role;
Counts.jsx already had the seesAllDepartments-style expansion).
RoomBoard.jsx and StaySettings.jsx don't use a department list at all,
so this class of bug doesn't apply to them.


## Root cause found: RLS, not just UI (migration 224)

The earlier hasReceptionAccess fix was necessary but NOT sufficient.
The actual reason Daniel could not see Obitex's MainBar credit is at
the database level:

sales_read (migration 33) limits a non-editor/non-auditor to rows they
recorded or rows in their own staff_locations. Daniel is front_desk
with Minimart + Reception, so MainBar sales rows are filtered out for
him. v_guest_department_credit reads through
v_customer_balances_by_staff (sales + sale_payments), and BOTH are
security_invoker = on — they run with the caller's permissions. So the
MainBar row never reached the app at all; no UI change could surface it.

224 rebuilds v_guest_department_credit directly on the base tables as
its own signed ledger and sets security_invoker = off, so it can
aggregate across departments the caller isn't assigned to. Branch
isolation is preserved explicitly in the view's WHERE clause via
app_branch() / app_sees_all_branches() rather than being inherited
from RLS.

Scope is deliberately narrow: the view exposes only (guest,
department, balance) for customers already linked to a guest. It does
not expose individual sales, customer names, phones, or who served
them. v_customer_balances_by_staff — which powers the per-department
customer list on Credit — is left security_invoker = on and untouched,
so front desk still cannot browse another department's customers.

Covers both app paths that read this view: loadGuestBalances (Credit's
guest balances, Reception dashboard deferred) and
loadGuestDepartmentCredit (a guest's Folio).


## Invoice did not match money owed (real billing bug)

v_stay_folio.orders_charge counts order items with BOTH filters:
  settlement = 'charged_to_room' AND order_type <> 'pr_damage'
but loadFolio fetched every order item for the stay with no filter,
and FolioStatement summed those raw lines into its own total. So a
printed invoice added in (a) PR/damage items that are free and (b)
orders already paid for at the department, coming out HIGHER than the
outstanding figure shown on the Folio, Credit page and Reception
dashboard. Guests were being handed inflated bills.

Fix: the statement no longer re-sums anything. orders_charge,
total_due and outstanding all come straight from v_stay_folio — the
same view every other screen uses — so they agree by construction
rather than by two code paths happening to match. Folio.jsx now splits
lines into billableLines (matching the view's filters exactly) and
freeLines (pr_damage), and passes only billable ones to the invoice;
free items print in a separate "Complimentary / not charged" table at
zero. Also added a "Paid at dept" badge on screen for lines whose
settlement isn't charged_to_room, which previously had no marker at all.

## Check-in time (migration 225)

stays.checked_in_at (timestamptz), stamped by a trigger on both routes
into 'occupied': INSERT for walk-ins, and the reserved -> occupied
UPDATE for arrivals. Deliberately not reusing created_at, which for an
advance booking is when the reservation was typed in, not when the
guest arrived. Existing occupied stays backfilled to midday on their
check_in_date rather than a fabricated exact time. Shown on the Folio
header and the invoice; omitted entirely when null.


## Check-in / check-out times on guest lists (migration 226)

226 adds stays.checked_out_at with a trigger mirroring 225b's, and
appends checked_in_at to v_occupancy_today. The view column goes at
the very END of the select list because CREATE OR REPLACE VIEW matches
by position and only permits appending — the exact mistake that made
153 fail.

The checkout trigger also CLEARS checked_out_at when a stay is
reopened, so a reopened-then-reclosed stay records when it actually
left rather than the first attempt's time.

Visibility is restricted to manager/gm/admin/auditor via one shared
helper (seesStayTimes in format.js) rather than four copies of a role
array. Front desk and bar keep seeing the dates exactly as before,
with no time. Applied in four places:
  - RoomBoard occupied cards: "in 2:45 PM" under the guest name
  - ReopenSearch (recent checkouts): departure time beside the date
  - Folio header: arrival time after the check-in date
  - Printed invoice: arrival time, passed as null for other roles so a
    front-desk-printed invoice cannot leak what that person cannot see


## Corrections: Reception tab (live guests)

New third tab on Corrections, visible to front desk (who take the
booking and so make the typos) and to editors overseeing them. Lists
every occupied or reserved stay with an Edit button for the guest's
name, phone, check-in date and scheduled check-out.

Read via a new loadLiveStays() rather than v_occupancy_today: that
view is keyed on ROOMS, so it would hide a second stay sharing a room,
and it omits the rate/cycle fields the sheet pre-fills.

Name and phone are corrected on the GUEST record, not the stay, so one
fix propagates to every past and future stay for that person —
renaming per-stay would fork their history. Dates apply to that stay
only, via a separate correctStayDates() (updateStayDetails
deliberately never touches check_in_date; this page is the one place
that should). The stays_no_date_overlap exclusion constraint still
guards the room, so a correction that would double-book is refused by
the database rather than silently corrupting the board — surfaced
through friendlyStayError.

## Notification tone and app icon badge

New src/lib/alert.js. The tone is synthesised with Web Audio rather
than shipped as an audio file: no added payload, no extra fetch on a
patchy connection, and nothing that can fail to cache offline. Two
short 880Hz pulses with gain ramps — an abrupt square edge clicks
audibly on phone speakers.

Wired to pendingCount in App.jsx, firing only when the count RISES.
Re-alerting on every 60s poll for something already seen would train
people to ignore it, and prevPending starts at null so the first poll
after sign-in never sounds for a backlog that predates opening the app.

navigator.setAppBadge puts the count on the installed app icon
(Android/Chrome, iOS 16.4+ from the home screen), wrapped so it is a
silent no-op where unsupported. Audio is armed on the first pointerdown
because browsers block playback until the user interacts with the page.

## Amstel Malt at MainBar — diagnostic, not yet a fix

227_diagnose_amstel_mainbar.sql is READ-ONLY. Deduction works like
this: saveBasket writes only to `sales`; the trigger
sync_sale_stock_movement (migration 03) then writes a matching 'sale'
movement using new.stock_item_id; v_stock_on_hand is built purely from
stock_movements and INNER JOINs stock_items. So a sale fails to reduce
stock if stock_item_id is NULL (typed line — the movement exists but
the join drops it), if sales point at a different stock_items row than
receipts did (duplicate item records), if the sale's location isn't
MainBar, or if the trigger is disabled. The six queries separate those
cases; the fix depends on which one it is.


## Corrections Reception tab: narrowed to reception staff + admins

seesGuests is now ['front_desk', 'gm', 'admin'] rather than
isEditor || front_desk. Storekeeper is an editor for stock purposes
but has no business in guest identity records, and auditor is
read-only oversight, so both are out. Manager is NOT included — say so
if it should be.

Also fixed a real bug in the tab as first built: the tab bar rendered
only under `canEdit && !ownOnly`, and reception staff are ownOnly, so
the group this tab exists for could never have reached it. The bar now
also shows when seesGuests, while Change history stays gated on
!ownOnly exactly as before — adding this tab must not quietly hand
front desk a view they were never meant to have. The guests view
itself is also guarded on seesGuests, not just the tab button.


## Deep audit sweep — findings

FIXED in this pass:
1. Credit page "Owed to Reception" header summed only .outstanding
   while each row below it showed outstanding + departmentCredit +
   billedToYou. The rows did not add up to their own total, and the
   figure disagreed with the Reception dashboard's deferredTotal.
   Latent before migration 224 (front desk received no department
   rows at all); live the moment that data started arriving.
2. Corrections deptFilter never reset on branch switch — an editor who
   picked a department then changed branch queried loadActivity with
   the old branch's location id and got an empty list with no
   explanation. Same class as the DailySales/Store fixes.
3. Counts newLoc only initialised when empty, so after a branch switch
   it still held the previous branch's location — the location a NEW
   count would have been created against, not merely displayed.
4. Receipt recomputed total as qty x unit_price instead of using the
   stored amount (written as .toFixed(2)), a second source of truth
   that could drift by cents. Same mistake as the folio invoice bug.

FLAGGED, not changed:
5. is_read_only is fetched in the boot payload (staff select *) but
   referenced nowhere in the UI. Read-only accounts see every control
   enabled and only discover the restriction as a raw trigger error on
   save. Not a security hole — block_if_read_only enforces it server
   side — but a poor experience for those accounts.
6. Room 209 is hardcoded in three places as "GM Office". If Nnewi ever
   has a real room 209 it would be hidden from non-GM/admin there.
   A category or explicit flag would be sturdier than a number.

CHECKED, CLEAN: no genuine temporal-dead-zone patterns remain (all
apparent hits are inside async handlers that run after mount); no
write/mutation errors silently swallowed; all polling intervals have
cleanup; no UTC date construction that could drift off Lagos time.


## 5. Read-only accounts: ReadOnlyBanner

Correction to the audit note: block_if_read_only (migration 155)
already raises a readable message — 'Your account is read-only — you
cannot make changes.' — so the toast was never a raw Postgres error.
The real gap was only that nothing warned BEFORE the work was done.

staff.is_read_only was already in the boot payload (staff select *)
and referenced nowhere. It now drives a persistent banner in Shell,
alongside the pending/update/staff-of-month banners.

Deliberately a banner rather than disabling every control: these
accounts exist to browse the whole app, and blanket-disabling buttons
would also block opening folios, receipts and statements, which they
are meant to be able to view. Say the word if specific save buttons
should also be greyed out.

## 6 & 7. rooms.is_internal replaces hardcoded '209' (migration 228)

The literal string '209' appeared in three places. A flag says what is
actually meant, scopes per branch automatically, and allows a second
internal room later with no code change.

228 adds rooms.is_internal, sets it for AWKA's 209 only (branch-scoped
on purpose — a Nnewi 209 would be a real guest room), and appends
is_internal to v_occupancy_today after checked_in_at, preserving every
existing column position.

App now reads the flag in four places:
  - SalesEntry / DailySales room-rate progress filters
  - loadRoomsSoldInMonth (excludes internal rooms from the count)
  - Corrections Reception list (item 7) — internal rooms hidden from
    front desk, visible to gm/admin, with the empty state respecting
    the filter so a hidden-only list still reads 'No live guests'


## Corrections: front desk lands on Reception

- Tab order for front_desk is now Reception, Entries (Change history
  stays hidden from them as before). Other roles keep Entries first
  with Reception second, so nothing moves for gm/admin.
- Default view for front_desk is the Reception tab.
- The Entries department subfilter no longer defaults to Reception.
  Reception records no sales rows at all by design, so defaulting to
  it (front desk's default_location_id since migration 204) opened
  Entries on a permanently empty list. It now picks their first
  NON-Reception department — Minimart at both branches — falling back
  to the old behaviour if Reception is genuinely all they have. The
  branch-switch reset uses the same rule.
- Department chips stay visible on the Reception tab (Minimart is
  right there), but they were inert there since a guest list isn't
  department-scoped. Tapping one now switches to Entries filtered to
  it, which is what tapping "Minimart" from Reception plainly means.
  No chip renders as selected while on Reception, since none is
  filtering anything yet.


## Staff of the Month photo: no long-press save/share

The banner photo is now a CSS background on a div instead of an <img>.
Long-press "Save image"/"Share" on iOS and Android targets image
ELEMENTS, so a background gives that menu nothing to act on. Also set:
-webkit-touch-callout: none (the iOS callout), user-select: none,
draggable=false and onContextMenu preventDefault (desktop right-click
and drag-to-desktop). role="img" + aria-label keep it announced to
screen readers, which the <img> alt was doing before.

IMPORTANT LIMIT: this stops casual saving from the banner, not a
determined person. The staff-photos bucket is PUBLIC (migration 221),
so the photo URL resolves for anyone who has it — via browser
devtools, the network tab, or simply pasting the link. Genuinely
preventing download needs the bucket made private and the app serving
time-limited signed URLs instead. Not done here because it changes how
every photo is loaded and was not asked for; say the word.


## 1. Yesterday's snapshot on Daily Sales

Ported from SalesEntry with one deliberate difference: on Daily Sales
the date is a CONTROL, so "yesterday" means the day before the date
being BROWSED, not literal yesterday. Anchoring to lagosToday() would
be wrong the moment someone looks back. lagosDaysAgo(n) gained an
optional second argument for this and stays backward compatible.
Still lazy — nothing fetched until the section is opened — and it
respects the department chip, unlike the SalesEntry version which is
always one department.

## 2. Store managers see stay times

SEES_STAY_TIMES now includes 'storekeeper' (Store Manager), covering
all four display points at once since the rule lives in one helper.

## 3. Guest records: duplicate merge (migration 229)

PART 1 IS A BUG FIX, not a feature. merge_guests (173) reassigns only
`stays`. Two columns pointing at guests were added afterwards and were
never included:
  customers.linked_guest_id (174) — department credit linkage
  stays.bill_to_guest_id    (180) — bill-this-room-to-that-guest
So merging left both pointing at the duplicate, which 173 then renames
to "[merged into X] ...". The effect is silent and financial: the
merged guest's department credit stops showing on the survivor's folio.
ANY MERGE DONE BEFORE THIS MIGRATION SHOULD BE RE-CHECKED for those two.

PART 2 adds find_duplicate_guests(branch) with three signals:
  same phone      - strongest
  initials match  - "GM" vs "General Manager", the prompting example.
                    Plain string similarity CANNOT catch an acronym,
                    which is why this is its own rule.
  similar name    - close spelling after titles/punctuation stripped
Nothing merges automatically: "Mr Okeke" and "Mrs Okeke" are a couple,
not a duplicate, and a shared phone often means one family.

UI sits on Corrections > Reception, gm/admin only, matching
merge_guests' own is_supervisor() guard so the button never appears to
someone the RPC would reject. Each pair shows both stay counts and
lets either record be the survivor — the shorter name is not always
the wrong one. Merging goes through a confirmation sheet spelling out
what moves, and noting the old record is renamed rather than deleted
so history stays auditable.


## Auditors and stay times

'auditor' was ALREADY in SEES_STAY_TIMES — the block was elsewhere:
auditors were not in the Rooms menu at all (More.jsx), so they could
never open the page the arrival times are displayed on. Added them.

Also gated "+ New booking", which was ungated — any role that could
open the room board could start a check-in. Phrased as
`staff.role !== 'auditor'` rather than an allow-list so no existing
role quietly loses booking rights it already had.

## Notifications while the app is closed (migration 230)

The existing tone/badge live in App.jsx's polling effect, which only
runs while the app is OPEN and foregrounded. A phone cannot alert on
its home screen icon from there — that requires Web Push delivered to
the service worker. Three parts:

1. public/sw.js gains 'push' and 'notificationclick' handlers. The push
   handler sets the app badge AND shows a notification, using a fixed
   tag so repeated pushes REPLACE rather than stack — it is a running
   count, not a feed. notificationclick focuses an existing window
   instead of opening a second copy.
2. src/lib/push.js + NotificationSetup.jsx: a prompt shown only to
   alert-eligible roles, and only until they decide. Deliberately not
   an automatic permission request on load — browsers permanently
   block a site that asks and is dismissed, so the ask must follow a
   tap the person chose to make. Hidden entirely when permission is
   already 'denied', since nagging cannot help at that point.
3. Migration 230 stores subscriptions, one row per DEVICE keyed on
   endpoint, RLS-scoped so a person manages only their own.

STILL REQUIRED, and cannot be done from here:
  a. npx web-push generate-vapid-keys
  b. Put the PUBLIC key in Netlify env as VITE_VAPID_PUBLIC_KEY and
     redeploy. Until this exists the prompt stays hidden by design
     (pushConfigured() is false), because subscribing without a key
     throws.
  c. Deploy supabase/functions/notify-pending (included) and set
     VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT as secrets.
  d. Schedule it with pg_cron — the SQL is in the function's header.

iOS note: Web Push works on iOS 16.4+ ONLY for a PWA added to the home
screen, not in a Safari tab.


## Project folder renamed to havilah-app

Renamed from havilah-inventory to match the working repo on disk, so
extracting a delivered zip lands on the existing folder instead of
creating a parallel one beside it. package.json / package-lock.json
"name" updated to match; nothing else referenced the old name, and the
build is unaffected (no path depends on the folder name).

This also fixes a quiet hazard: with two differently-named folders,
anything added in a NEW subfolder — supabase/functions/ being the
first case — would never appear in the working repo unless the folder
was copied across by hand, and would be easy to miss entirely.


## Fix: alert tone fired on load (AudioContext error in console)

pendingCount starts at useState(0), so the FIRST poll returning an
existing backlog (2 submitted counts) compared 2 > 0 and read as a
rise — sounding the tone on load, before any user gesture. Chrome
blocks that and logs "The AudioContext was not allowed to start",
which is exactly what appeared in the console. The prevPending !== null
guard never helped, because the effect's own first run had already
seeded it with the placeholder 0.

Added pendingLoaded, set only when a poll actually resolves. The first
real value seeds the baseline silently; alerting starts from the
second. Signing out resets both, so the next sign-in re-seeds rather
than alerting at its existing backlog.

## push.js now says why the prompt is hidden

pushConfigured() returning false silently made a missing
VITE_VAPID_PUBLIC_KEY indistinguishable from a broken build during
setup. It now console.warns which condition failed.


## Counters alerted when their count is verified (migration 234)

Bar, front desk and every other role now get a tone, badge and push
when a count THEY submitted is verified. This is the opposite
direction to the existing alert: ALERT_ROLES tells verifiers "work is
waiting for you" (status = 'submitted', per branch); this tells the
counter "your work was checked" (status = 'verified', counted_by =
that person). Different audience, different trigger, so it has its own
high-water mark rather than reusing last_count.

Keyed on the newest verified_at, NOT a row count. Verifying one count
while an older one ages out of the window leaves the total identical,
so a count-based check would miss it entirely.

- 234 adds push_subscriptions.last_verified_seen, seeded to now() for
  existing devices so switching this on does not announce every
  historical verification at once.
- App.jsx polls loadMyVerifiedCounts on the same 60s cadence. The first
  pass only records the position — the same "seed silently, alert from
  the second pass" rule the pending alert needed after it fired on load.
- The Edge Function gained a second pass targeting staff_id. It
  advances last_verified_seen even when a send fails for a transient
  reason, or a persistent error would re-announce the same
  verification every five minutes forever.
- alertEligible is now true for every role, since anyone can receive
  the verification push. It was previously limited to ALERT_ROLES,
  which would have hidden the subscribe prompt from exactly the bar
  and front-desk staff this feature is for.

TDZ note: justVerified sits in the badge effect's dependency array,
and dep arrays ARE evaluated during render, so it is declared with the
other alert state near the top rather than beside its own effect.
Declaring it below would have been the same crash class as the earlier
"Cannot access before initialization".


## Edge Function: WORKER_ERROR made diagnosable, and two likely causes fixed

Every invocation returned 500 WORKER_ERROR with no readable reason.
Three changes:

1. esm.sh -> npm: specifiers. web-push is a NODE library and Supabase
   Edge Functions run Deno. Importing it from esm.sh can fail at module
   load, which kills the worker before any handler runs — exactly a
   boot-time WORKER_ERROR. Supabase's runtime supports npm: specifiers
   with Node compatibility, which is the supported way to use it.
2. setVapidDetails moved OUT of module scope into initVapid(), called
   inside the handler. At module scope a throw is fatal before any
   request is served, so the caller can never be told why.
3. The whole handler is wrapped, and errors return 200 with
   {ok:false,error,stack} rather than throwing. Deliberate: a 500 body
   is replaced by the platform's generic WORKER_ERROR message, which is
   what hid the cause in the first place. 200 + ok:false puts the real
   message in net._http_response, where it is readable without the
   dashboard log.

initVapid also names exactly which secrets are missing, and rejects a
VAPID_SUBJECT lacking mailto:/https: — a common cause that otherwise
looks identical to a missing key.


## Typed room charges that are really stock items

Two paths add a room charge: "Add a drink or minimart item" picks from
the catalogue and deducts stock; "Add a restaurant order" is typed and
does not — correct, since a plate of food is not a countable stock
unit.

The failure was a DRINK entered through the restaurant path. On 13
Sept Alphonso was billed N897 for 1 Amstel Malt as free text: the
money was right, the bottle never left inventory, and nothing on
screen said so. The order_items trigger (108b) deliberately skips
items with a null stock_item_id, so it cannot be fixed downstream —
it has to be caught at entry.

RoomChargeSheet now matches what is being typed against the catalogue
and, on a match, warns that the item will be billed but not deducted,
with a one-tap switch to the picker. Deliberately a warning rather
than a block: an unusual one-off with a name close to a stocked item
is still legitimate, and blocking it would push staff to misspell
things to get past the check.


## Check-in AND check-out times on checked-out guests

ReopenSearch showed only the departure time. It now shows both ends of
the stay on their own line — "In <date> <time> - Out <date> <time>" —
since verifying a checkout needs both, and squeezing two timestamps
beside the date truncates on a phone. Still gated on seesStayTimes
(storekeeper/manager/gm/admin/auditor), so front desk and bar see the
dates exactly as before.

## App icon rebuilt with depth

Same palette, same geometry, same 14px radius. The 3D read comes from
lighting rather than perspective: one source at the top-left, so every
tile has a lit top edge (white stroke as the specular catch), a darker
extruded slab offset down-right as its side, and a cast shadow
anchoring it. Background is a soft radial bowl so the plate reads as a
surface, with a sheen over the top-left and a hairline rim so it does
not dissolve into a dark home screen.

Extrusion is deliberately ~1px at a 64 viewBox: enough to lift at icon
size, small enough to survive scaling to a 24px favicon. Regenerated
icon-192, icon-512 and apple-touch-icon from the SVG. The maskable
variant drops the rounded corners and the rim — the OS applies its own
mask and would clip a rounded plate.


## Merge duplicate CUSTOMERS (migration 242)

Credit accounts at MainBar, Minimart, OpenBar and Restaurant, added
under Guest records on Corrections > Reception. gm/admin only, matching
merge_customers' own is_supervisor() guard.

Ran the read-only precheck (241) FIRST this time, per the rule adopted
after the Amstel merge. It established three things that shaped the
migration:
  - customers IS branch-scoped, so the merge refuses across branches.
    This is exactly the check whose absence broke the stock merge.
  - only TWO columns reference customers (sales.customer_id,
    credit_repayments.customer_id), so the repoint is small and known
    rather than discovered dynamically.
  - (branch_id, name) and (branch_id, name_key) are both UNIQUE, so
    exact-name duplicates CANNOT exist — which is why the precheck
    found none and why the finder has to be fuzzy. The rename on merge
    also has to stay unique, so name_key is nulled (that index applies
    only WHERE name_key IS NOT NULL).

Finder uses same phone, initials match, and prefix similarity.
"Initials match" is what catches GM vs General Manager — the pair that
prompted this. No spelling-similarity measure can connect them; they
share almost no characters.

The confirm sheet shows each side's BALANCE and which departments it
is used at, plus the combined total afterwards. Merging customers
moves real money between accounts, so the decision needs the numbers,
not just the names.


## 242b: merge_customers already existed — fixed rather than replaced

242 failed: merge_customers(uuid, uuid[]) was already in the database
with parameters p_keep / p_merge. Those names are kept so CREATE OR
REPLACE works without a DROP and any existing caller keeps working;
the app's RPC call was changed to match, not the other way round.

The existing version repointed sales and credit_repayments correctly
but had two defects:
  1. NO BRANCH CHECK — it would merge a customer across branches,
     moving that debt onto the wrong branch's books. Same class of bug
     as the Amstel stock merge.
  2. It DELETEd the duplicate row, destroying any record of who was
     merged into whom.

Both fixed. The role check is left exactly as found
(storekeeper/manager/gm/admin): narrowing it would silently remove an
ability store managers already have, which is a separate decision, not
something to slip into a bug fix. The UI gate stays at gm/admin, so the
app is narrower than the database permits.


## Invoice: blank pages fixed, and made easier to read

ROOT CAUSE of the extra pages: the print CSS used
`body * { visibility: hidden }`. Hidden elements still OCCUPY LAYOUT
HEIGHT, so the app's entire scroll height kept generating sheets after
the invoice ended. Absolutely positioning .invoice-print took it out
of flow but did nothing about the phantom height behind it.

Fix: FolioStatement now renders through a React portal onto
document.body, so print CSS can `display: none` every other body
child outright — removed from layout, not merely invisible. The
portal's own flex/overflow chain is unwound too
(overflow/max-height released), or the statement would be clipped to
one screen and later pages would never print at all.

Other print corrections:
  - thead/tfoot as table-header-group/table-footer-group, so column
    headings REPEAT on page two onward instead of leaving unlabelled
    columns of numbers
  - page-break-after: avoid on headings; break-inside: avoid on the
    balance block and signature line, so neither is stranded alone
  - last-child margin zeroed — a trailing margin can spill a whole
    extra sheet on its own
  - printOnly() deleted: with the portal there is only one
    .invoice-print in the DOM, so the show/hide dance is dead code

Readability:
  - statement number derived from the stay id (stable across
    reprints, so two copies carry the same reference)
  - room line reads "Accommodation — Room 205, 30 nights at N18,750
    per night" rather than a bare night count
  - subtotals for accommodation and for food/drinks/minimart before
    the total, so the figure is arrived at rather than asserted


## Fix: room balances appearing under every department (my regression)

When the Obitex fix made the guest-balances section show regardless of
the selected chip, it started appearing under MainBar, Minimart and
OpenBar too — where a guest's ROOM debt reads as money owed at that
department. Vincent Onwudinjo's N70,000 room balance showing while
looking at Minimart is that bug, not duplicated data: his only
department credit is a genuine N500 chin-chin sale at Minimart on 26
Sept.

Now shown under Reception and All departments only. Under any other
department a one-line pointer — "Guest room balances are under
Reception" — keeps them findable without implying they belong there.
Relabelled from "Owed to Reception" to "Guest room balances", which is
what the figure actually is.

The Obitex case still works: that was about a guest's DEPARTMENT
credit aggregating across departments on the folio, which is a
different mechanism (v_guest_department_credit) and untouched here.


## "Link to a guest" reachable from Reception

The control existed only INSIDE a customer's statement, and Reception
shows guest room balances rather than a customer list — so from there
it could not be reached at all. Vincent's Minimart account was only
linkable by knowing to switch to the Minimart chip first.

Two changes:
  - the link sheet now reads a linkTarget rather than open.customer,
    so it can be started from anywhere instead of only from a statement
  - Reception gains "Department accounts not linked to a guest":
    every active customer with a balance and no linked_guest_id, with
    the departments it is owed at and a Link button

That section is the point of the fix. These are precisely the balances
that vanish at checkout — the room is settled while money sits on a
named account at a bar or the minimart, and nothing joins the two.
Surfacing them where the front desk already stands beats expecting
someone to guess which department chip to look under.

Only accounts actually owing are listed; a zero balance needs no
attention.


## Credit day filter — already existed; fixed what disrupted it

The Credit page ALREADY had a date filter (dayFilter + loadCreditOnDate,
with a date input and a "Back to balances" control). I started building
a second one before checking, and removed it.

The real defect was the one the request warned about. The sections
added in earlier rounds — the room-balances pointer and the
guest-room-balances list — sat OUTSIDE the dayFilter ternary, so
selecting a date showed that day's credit with current balances still
listed underneath, reading as though they were part of that day.
Both are now gated on !dayFilter, matching how the department balance
list already behaved.

Also restored loadCreditOnDate, which my removal of the duplicate had
deleted along with it. Rebuilt from the UI's actual row shape
(kind/customer/item/qty/location_id/who/amount plus takenTotal and
repaidTotal) and verified column names against saveRepayment rather
than assumed: credit_repayments uses paid_on and recorded_by, not
received_by, which would have failed at runtime rather than at build.


## PR / complimentary shown at cost on the daily close

The cashier's confusion was presentational: PR items appeared among
the day's orders with nothing telling them those are outside the
reckoning. Revenue treatment was already correct — PR never enters
gross sales or the folio (migration 164) — so nothing about the money
changed here.

New line on the Sales dashboard close-of-day, placed BELOW "Total
income for the day" and outside its border, reading "PR /
complimentary given (at cost)" with the itemised lines under it and an
explicit note that it is not money and not part of the total. Putting
it above the total is precisely what would perpetuate the confusion.

Valued at COST, per the request. Three paths produce PR and all three
are counted, since they live in different tables:
  - writeoffs -> stock_movements 'complimentary', which carry
    unit_cost ON THE ROW, so the cost is exact rather than looked up
    against a price that may have changed since
  - PR sales -> sales with order_type 'pr_damage', costed from the
    item's cost_price
  - restaurant PR -> order_items with order_type 'pr_damage'

Restaurant meals have NO cost figure: food is not stock-tracked and
the ingredients were expensed when bought. Rather than invent a cost,
they are reported separately at menu value, clearly excluded from the
cost total. An invented figure would be worse than an honest gap,
especially on a number someone may take to an accountant.


## Consolidation pass (review of 28 Sep 2026)

Four mechanical changes, each verified to change no behaviour.

1. RECEPTION DASHBOARD — one component (components/ReceptionDashboard.jsx)
   It was copied inline into SalesEntry and DailySales (83 and 80
   lines), and the copies had already started to drift. A diff showed
   they differed in exactly one real way: rooms-sold sits inside the
   dashboard on Sales but OUTSIDE on Daily Sales, where it must still
   show for past dates when the dashboard (current balances only) is
   hidden. That became the showRoomsSold prop. The internal-room
   filtering both pages computed identically — and used for nothing
   else — moved into the component too.

2. ROLES — one file (lib/roles.js)
   Role sets were typed inline 21 times in five combinations. Now named
   groups that mirror what the database enforces:
     SUPERVISOR     gm, admin                     = is_supervisor()
     MANAGEMENT     manager, gm, admin            = can_manage_rooms()
     EDITOR         + storekeeper
     OVERSIGHT      + storekeeper, auditor
     RECEPTION_EDIT front_desk, gm, admin
   VERIFIED: every gate compared old vs new for all 7 roles — 140
   checks, 0 differences. No one's access changed.

   Two misleading names surfaced and were resolved by MEMBERSHIP, not
   by name: OVERSIGHT_ROLES (in Shell, More, App) and SUPERVISOR_ROLES
   (in Folio) have always been manager/gm/admin — i.e. MANAGEMENT —
   despite their names. Folio's SUPERVISOR_ROLES in particular is NOT
   the gm/admin set that is_supervisor() means.

   One genuine inconsistency left deliberately untouched, since fixing
   it would change access: `seesAllDepartments` means manager/gm/admin
   in SalesEntry but storekeeper/manager/gm/admin/auditor in Recovery.
   Same name, different sets. Needs a decision, not a refactor.

3. GUEST MERGE — one location (Corrections > Reception)
   The two entry points were NOT interchangeable: Settings had a manual
   search that can merge ANY two guests; Corrections showed only pairs
   the finder detected. Removing Settings outright would have lost
   merges like "Chief Okonkwo" / "Emeka Okonkwo", which match no finder
   rule. So the manual sheet MOVED to Corrections ("Merge two guests not
   listed above") and was then removed from Settings.

4. DEAD CODE — loadBarStaff, loadAdvancePayments,
   loadRestaurantRoomCharges removed. Each confirmed to have zero
   callers; removal used exact brace matching, and the function list
   was diffed afterwards to prove exactly these three went and nothing
   else (an earlier slice-based removal had deleted a neighbour).

Build passing is NOT sufficient evidence for changes like these: an
unimported identifier at module scope is a runtime crash that Vite
does not catch. So imports were verified directly for every role
group and every JSX component used. That check caught one real break
mid-pass (More.jsx referenced MANAGEMENT with no import) before it
shipped.


## seesAllDepartments unified on OVERSIGHT

Decision: store managers and auditors see all departments. All three
pages that gate department chips now use is(staff.role, OVERSIGHT):
  - Recovery: already OVERSIGHT — unchanged
  - Credit:   was `isEditor || role === 'auditor'`, which is exactly
              OVERSIGHT; rewritten to say so. Verified identical for
              all 7 roles.
  - Sales:    was MANAGEMENT. Gains storekeeper and auditor; nobody
              loses access.

IMPLICATION worth knowing: on the Sales page, department chips choose
where a sale is RECORDED, not just what is viewed. So store managers
can now ring up sales at any department. Auditors cannot reach the
Sales page, so nothing changes for them there. The database's own
rules still apply regardless — e.g. block_awka_storekeeper_on_behalf_sale
still refuses Awka store-manager sales recorded on behalf of others.


## Sales page: store managers SEE all departments, RECORD only their own

Corrects the previous change, which made seesAllDepartments OVERSIGHT
on Sales and so let store managers ring up sales at ANY department.
The intent was viewing only.

Seeing and recording are now separate on this page:
  seesAllDepartments = OVERSIGHT          -> which chips appear
  canRecordAt(id)    = MANAGEMENT or own  -> where a sale may be saved

Resulting access (verified per role):
  bar, front_desk        see + record own only        (unchanged)
  storekeeper            see ALL, record own only     (the change)
  manager, gm, admin     see + record all             (unchanged)
  auditor                cannot reach this page

Enforced at TWO layers, deliberately:
  1. SAVE GUARDS — commit(), commitWriteoff(), and the inline restaurant
     PR/damage save all refuse when not permitted. The restaurant save
     checks against the RESTAURANT location, since that is where it
     records, not the selected department. Guarding the saves covers
     every route into them — including writeoffs opened from inside the
     item picker, which have no button of their own.
  2. UI — "+ Sell Item", "Add a restaurant order", and the tier row
     containing "PR / Damage" are hidden when viewing someone else's
     department, replaced by a note saying why. Hiding alone would not
     be enough: four separate entry points exist, and missing one would
     leave a live path.

Delete was already restricted to gm/admin, so it needed no change.


## Database notes: 245-247 (foundation hazards, 28 Sep 2026)

245  merge_customers assigned name_key, a GENERATED column -> every
     customer merge from the app failed. Line removed; renaming the row
     regenerates the key. Also suspends the on-behalf trigger for its
     own repoint.
246  Three validation triggers fired on EVERY edit, re-checking columns
     the edit never touched. Narrowed to INSERT or UPDATE OF their own
     columns (the pattern validate_sale_date already used):
       on-behalf sale    -> recorded_by, on_behalf_of
       on-behalf repay   -> recorded_by, credit_staff_id
       payment method    -> method, sale_id
     Also fixes a latent bug: disabling a payment method would have
     blocked editing the AMOUNT of old payments made with it.
247  The on-behalf rule named one staff id. Now staff.no_on_behalf_entries,
     set for Store Manager (Awka) only — exactly the previous behaviour.
     Guarded so only gm/admin can change it; the check functions are
     SECURITY DEFINER so row-level security can never hide the flag and
     silently let an entry through.
Checked, not a bug: verify_stock_count DOES post adjustment movements
for every variance, dated to the count.

## Guest credit at the till (Phase 1)

ROOT CAUSE of guests' debt landing on free-floating customer accounts:
button order. A bartender's natural path is + Sell Item -> Credit ->
customer picker, where "Room 203 Mr Vincent" gets typed and a new
account is born. The correct path, "Charge to a room", was a separate
button that had to be chosen BEFORE starting the sale.

Now, at the credit step, in-house guests are listed first
("Rm 203 · Vincent Onwudinjo"). Tapping one asks:
  - Add to room bill -> the WHOLE basket becomes one order on the
    folio (chargeBasketToRoom), stock deducting as normal. Any split
    is cleared, since the whole sale goes to the room.
  - Separate bar tab -> a customer account LINKED to the guest
    (getOrCreateGuestTab), billed separately but visible at checkout.
    Reuses an existing linked tab. Refuses rather than claim an
    account already linked to a different guest of the same name.

Only OCCUPIED rooms are offered (a reservation has not arrived), and
internal rooms are excluded. Staff see names beside room numbers, with
a prompt to check the name matches before charging.

Typed room-like names ("Room 102", "Rm 203", "203") are intercepted and
redirected to the guest list, with an escape hatch ("Not a guest —
create anyway"). Tested against 14 cases including the actual bad names
found in the data; no false positives on real names.

Room charges require a connection — they are not queued offline like
ordinary sales, and say so rather than failing silently.

Phase 2 (front-desk approval above N5,000) is separate: it adds an
approval status and changes what the folio counts as owed.


## Room charge approvals (Phase 2) — migrations 248, 249, 250

Room charges over the branch limit (N5,000), made by staff other than
front desk or management, wait for front-desk approval before reaching
the guest's bill. If refused, the bartender collects by POS, Cash,
Credit or Split.

248 (schema)   orders.approval_status: approved | pending | rejected |
               collected, default 'approved'. v_stay_folio.orders_charge
               now also requires approval_status = 'approved'.
               branches.room_charge_approval_limit, default 5000.
               PARTIALLY APPLIED: the SQL editor committed statements
               individually, so its temp-table safety check lost its
               snapshot while the changes went through. Verified after
               the fact instead: all 30 existing orders are 'approved', so
               the new filter excludes nothing and every bill is unchanged;
               and v_stay_folio's security_invoker was null BEFORE (recorded
               by the 151 check) and is null now, so nothing was lost.
249 (flag)     Trigger on order_items marks a NEW room charge pending when
               over the limit and served by bar/storekeeper. Can never
               flip an existing order (10-minute window, decided_at null).
250 (decide)   approve_room_charge, reject_room_charge (reason REQUIRED),
               collect_rejected_room_charge.

Lesson carried into 249/250: each is ONE DO block, so it applies fully
or not at all, logs itself last, and is safe to re-run.

COLLECTION is one transaction: create the sales (stock comes off via the
sales trigger), delete the room-charge lines (their stock movements are
removed by the order_items trigger), then PROVE no room_charge movement
survived — aborting the whole thing otherwise — so a bottle is never
deducted twice. The order is kept as 'collected', the record that front
desk refused it. Business date is today in Lagos, so the money lands in
today's cash-up. Built against the LIVE column list: sales.amount and
order_items.amount are generated (never written); sales.location_id is
required but a typed charge has none, so the collecting department is
the fallback.

App:
- Folio: billableLines now also requires approval 'approved' — the SAME
  rule as the view. Without it a pending charge would print on the
  invoice while missing from its total. Pending charges show in their
  own box, clearly not on the bill; list lines are badged.
- Till: says "Sent to front desk for approval ... not on the bill until
  they approve it" when a charge goes pending.
- RoomChargeApprovals (Reception view, APPROVE_ROOM_CHARGES roles):
  approve, or refuse with a reason. Polls every minute.
- CollectRefusedCharges (any department where you can record): refused
  charges for the whole branch, with the refusal reason, collected by one
  method or split; credit needs a customer.
- APPROVE_ROOM_CHARGES = front_desk, manager, gm, admin — mirrors the
  database functions exactly. RPC parameter names cross-checked against
  the SQL signatures.

DEPLOY ORDER: this zip FIRST, then 249, then 250. With the app live
before 249 runs, there is never a moment where a charge can go pending
with no screen to approve it.


## 251: room-charge stock trigger had never worked

sync_order_item_stock_movement (108b) declared a record `o` and queried
`from orders o`, so `o.branch_id` resolved to the empty VARIABLE:
"record o is not assigned yet". Every room charge of a CATALOGUE item
failed; typed ones escaped because the function returns early for lines
with no stock item. Evidence: zero 'room_charge' stock movements existed
in the whole database. Likely origin of staff typing drinks onto rooms —
the only way a room charge would save, and typed lines never deduct.
Fixed by renaming the variable; behaviour otherwise identical.

## Bartender waiting panel, front-desk chime, bell tone, clean sign-out

WAITING: a toast (3 s) was the wrong tool for "sent for approval" — gone
before it was read, leaving the bartender to ring the front desk.
MyPendingRoomCharges stays on the Sales page for exactly as long as HIS
charges are pending, with how long each has waited, then chimes and
reports the outcome (approved -> on the bill; refused -> reason, collect
below). Polls every 15 s. First load only records state, so charges
already waiting are not announced as newly decided.

FRONT DESK: RoomChargeApprovals now chimes and announces each NEW charge
("Room 203 · N7,500 (Daniel)"), polling every 15 s instead of 60. This is
what removes the need for the intercom.

TONE: was two 0.2 s sine blips at one pitch. Now a reception bell —
inharmonic partials (x2.0, x2.76, x5.4) for a metallic strike, 8 ms
attack, long decay. Two sounds, told apart by ear:
  attention  two rising dings — something needs YOU
  resolved   rising three-note arpeggio — your request was answered
Rendered offline with identical parameters to check it: peaks 0.61 and
0.62, headroom below clipping. Previews: tone-attention.wav,
tone-resolved.wav. NOTE: this is the in-app tone. A push that arrives
while the app is closed uses the phone's own notification sound, which a
web app cannot replace.

TOAST: accepts { duration } as an optional third argument. Every
existing call keeps its old timing.

SIGN-OUT (signOutCleanly): sign-out used to end the session only. The
phone stayed subscribed under that person, kept their badge and their
tray notification, and went on receiving their alerts. Now it clears the
badge, closes shown notifications, unsubscribes, and deletes the
subscription row — BEFORE ending the session, since that delete needs
the person signed in (RLS staff_id = auth.uid()). Every step is
time-limited: navigator.serviceWorker.ready never resolves on a device
with no active service worker, and awaiting it would have left people
unable to sign out at all.


## Store managers: own entries only; no customer merging (migration 252)

Segregation of duties — the custodian of stock should not be able to
alter the sales records stock is reconciled against.

WHY THE DATABASE. Corrections writes straight to sales, sale_payments
and stock_movements, and their edit/delete policies let app_is_editor()
— which includes storekeeper — change ANY row at the branch. Hiding
buttons alone would have changed nothing real.

WHY NOT EDIT app_is_editor(). READ policies (e.g. sales_read) use it too;
removing storekeeper would have cut what they can SEE. So a separate
app_can_edit_any() (manager/gm/admin) is used only in the six edit and
delete policies, changed with ALTER POLICY so each keeps its name,
command, roles and permissive setting.

Store manager, after 252:
  sale edit        own today/yesterday only
  sale delete      never
  movement edit    own today/yesterday only
  movement delete  own today/yesterday only
The one difference from bar staff is deleting their OWN recent stock
movement: undoing their own wrong transfer or receipt is the core of the
job. Deleting anyone else's is impossible. The storekeeper condition in
moves_remove is explicit, so it hands bar staff no new delete right.

App (Corrections): isEditor is now MANAGEMENT, mirroring
app_can_edit_any. Store managers can still open Corrections (canEdit),
keep the all-departments chips as a filter over their own rows, and see
Delete only on their own recent STOCK rows. They no longer see Change
history, which is the audit view of everyone's edits.

VERIFIED: app buttons vs database permissions across all roles, entry
kinds, actions and ownership — 72 cases, 0 mismatches.

merge_customers: storekeeper removed from its role list (UI was already
gm/admin only).


## Store manager: bottom bar, landing, and default location (253)

Bar is now Store · Stock · Counts · (Sales) · More, landing on Store —
their working screen. Previously Sales · Store · Stock · More, landing on
Sales, which had become secondary for them. Sales appears ONLY if they
are assigned to a sales department (Nnewi covers OpenBar; Awka covers
none), via a recordsSales prop derived from their assignments; otherwise
they cannot record a sale anywhere and Daily sales in More does the
viewing better.

startingDept(list, staff, own): every department-chip screen used to do
`default_location_id || list[0]`, trusting the default blindly. That
breaks whenever the default isn't on that screen — a Store default on a
screen whose list excludes stores — and the screens' own reset logic
reset back to the same bad value, so the page stayed stuck. Now: the
default if it's on this screen, else the first assigned department that
is, else the first. Applied to Sales, Credit, Recovery and Counts.
Tested against the real function: store managers land correctly; front
desk, bar and managers behave exactly as before.

253 sets each store manager's default to their branch's Store (both had
none). DEPLOY THE APP FIRST: the old app would get stuck on a Store
default. Refuses unless each branch has exactly one store.

Caught before shipping: the Shell destructure edit silently failed to
match, leaving recordsSales used but undeclared — a crash on sign-in for
every user that the build does not catch. Found by checking declarations
directly after the build passed.


## Auditor independence (migration 255)

Principle: an auditor sees everything, signs off what is right, and
changes nothing.

ADDED — change history. Corrections is now in the auditor's menu, and
they land straight on its read-only history. Two things had to change,
not one: app_can_view_audit() (used only by inventory_audit.audit_read)
EXCLUDED auditors, so the database refused them the audit log; and
Corrections only fetched history when !ownOnly, which auditors are, so
it would never have loaded even with permission.

REMOVED — deleting counts. A count is evidence. auditor taken out of
app_can_delete_submitted_count() (used only by counts_remove), out of
count_lines_remove, and out of CAN_DELETE_COUNT in the app.

REMOVED — write-offs. moves_write had a clause just for auditors
(damage/complimentary). Removed, and the rule now states
NOT app_is_auditor() outright rather than relying on app_can_record()
excluding them. The Stock page's write-off feature existed only for
auditors, so it and the WriteoffSheet component are gone; Stock is
read-only for everyone.

STILL WORKS: verifying counts, adjusting a count line, posting opening
balances — all run through functions with elevated rights, not governed
by moves_write. The migration CHECKS this and refuses to apply if any
of them does not, rather than assuming.

UNCHANGED BY DECISION: adjusting a count line before verifying (flagged
and traceable; left as-is pending a decision).

BAR: Daily sales · Counts · Variances · Stock · More. Counts is where
the verification alert sends them. Stock kept deliberately — auditors
cannot reach it through More, so dropping it from the bar (as first
suggested) would have removed their stock view entirely. Verified by
running the real tab logic for every role: only the auditor's changed.

NOTE: store managers can still READ inventory_audit at the database
level (app_can_view_audit includes storekeeper) though the app no longer
shows them history. Read-only, so not a tampering risk; left as found.


## One definition for every role's tabs (lib/tabs.js)

The bar (Shell), the More menu and the landing screen (App) each decided
a role's tabs on their own. Moving a tab onto a bar needed three
coordinated edits; the earlier store-manager and auditor changes missed
one, and it showed:
  - store managers saw Counts on the bar AND in More
  - auditors saw Counts and Variances twice
  - the "counts awaiting verification" badge stayed on More even after
    Counts moved onto the bar, pointing at a tab that no longer held it

Now tabsFor(role) defines each bar. More hides anything on the bar
(replacing its hand-written per-role exclusions), every role lands on its
FIRST tab (landingTabFor), and the badge goes to whichever tab holds
Counts (countBadgeTabFor). Change a role's tabs in one place and all
three follow.

VERIFIED by running the real old and new logic for every role: no
duplicates remain, no role lost access to any screen, and every landing
screen is unchanged except the auditor's (below).

## Auditor bar and default location

Bar: Counts · Variances · Daily sales · History · More, landing on
Counts. Ordered by their work — verify submitted counts (their one
sign-off, and where the alert points), investigate the variances those
counts reveal, review the day's sales, then History: every edit and
deletion at the branch, the evidence that shows tampering. Corrections
appears as "History" for them since they only ever see its read-only
view. Stock moves to More; the Stock menu item now includes auditors,
so it stays reachable.

DEFAULT LOCATION: a store manager has a natural home (the Store); an
auditor does not — their job is the whole branch, and a single default
department would quietly narrow every review. Their default is
therefore ALL DEPARTMENTS, which Daily sales, Stock and Variances
already open on. No single default_location_id is set for auditors.
Credit and Recovered debt are built one department at a time and have
no whole-branch view, so they still open on the first department;
adding one is a separate change to how their totals are calculated.


## Icons for Counts, Variances and History

Three bar tabs had no icon and showed as bare text: Counts (auditor and
store manager bars), Variances and History (auditor bar).
  count     checklist with ticks — deliberately not a clipboard, since
            Stock already is one and both sit on the store manager's bar
  variance  balance scale — system figure against what was found
  fix       clock with a turn-back arrow — History (Corrections)
Same 24px grid and 2px round stroke as the rest. Checked rendered at
60px (how a 3x phone draws a 20px icon) and at a true 20px: all three
stay legible. Verified every tab on every role's bar now has an icon.


## Manager limits; Awka Manager writable (migration 256)

Principle: a manager runs the day; the GM holds final authority over
money, prices and anything that can't be undone. Three places the line
was drawn inconsistently, now fixed:

1. DELETION -> GM/admin. A manager could delete any sale or stock
   movement but not a N500 repayment. Managers still EDIT anyone's
   entries.
   Done with a delete_sale() function, not just a tighter rule: the app
   deleted a sale in TWO client calls (payments, then sale). Managers
   must keep the right to delete PAYMENT rows because editing works by
   deleting and re-adding them, so tightening only the sale rule would
   have let a manager's delete strip the payments and then fail on the
   sale — a sale with no payment, silently gone from the cash-up.
   delete_sale() removes both in one transaction, GM/admin only.
2. ROOM RATES -> GM/admin, matching item prices (Catalog). rooms_update
   now requires is_supervisor(). The app's only direct room write is
   room rates; out-of-service runs through set_room_service_status(),
   which has elevated rights and its own manager check, so it still
   works. Settings now holds only GM/admin sections, so it left the
   manager's menu.
3. MERGING CUSTOMERS -> GM/admin in the database, matching the app.
4. Awka Manager: read-only flag lifted.

VERIFIED: app buttons vs database permissions for every role, entry
kind, action and ownership — 84 cases, 0 mismatches. No screen deletes
sales or writes rooms directly other than through the gated paths.

KNOWN GAP (deliberately not closed): because editing deletes payment
rows, a manager — or bar staff on their own recent sales — could still
remove payment rows directly through the database, outside the app.
Closing it means making editing one database step too.

DEPLOY ORDER: APP FIRST, then 256. With 256 applied under the OLD app,
a manager deleting a sale would hit exactly the two-step failure above.
With the new app first, the only effect in the gap is that a GM's sale
delete fails cleanly until 256 creates delete_sale().


## Sale edits in one database step (migration 257)

Closes the gap left open in 256. Editing a sale deleted and re-added its
payment rows in separate calls, so everyone able to edit also held the
right to DELETE payment rows directly — and could strip a sale's
payments outside the app, dropping it from the cash-up.

Now edit_sale() changes quantity, price and payments together, and
delete_sale() (256) removes a sale and its payments together. With both,
the app never updates or deletes a sale or payment row directly (the
write map was re-run to prove it: only the till's INSERTS remain), so
sales_amend, sales_remove, payments_amend and payments_remove refuse
everyone. Both functions carry elevated rights and apply the same
who-may-edit rule sales_amend used to: manager/gm/admin anyone's at the
branch, anyone their own from today or yesterday.

edit_sale() also enforces, in the database, that payments add up to
quantity x price (previously only the screen checked), and adds one
rule: credit needs a customer — editing a cash sale into credit used to
create a debt nobody owed.

Removed: updateEntry's sale branch. It collapsed every payment into one
row of the first method found (or 'cash'), so correcting a part-cash,
part-credit sale would have erased the credit and the customer's debt.
Nothing called it for sales; it now throws instead.

Guard: 257 refuses to apply if any function without elevated rights
updates or deletes sales or payments, since closing those rules would
break it. It also refuses to run before 256.

DEPLOY ORDER: this zip, then 256, then 257, back to back. Between the
zip and 257, EDITING fails cleanly (edit_sale doesn't exist yet) — so
run 257 promptly. Nothing can be corrupted in the gap.


## Payments only on new sales (migration 258)

257 stopped payments being stripped; 258 stops them being padded. The
payment INSERT rule allowed a row on ANY sale in the branch at any time.
Now only on a sale created in the last 15 minutes — the till adds
payments immediately after creating the sale.

Deliberately NOT "a sale you recorded yourself": queued offline sales
replay under the ORIGINAL staff (p.staffLite) but are sent by whoever is
signed in at reconnect. On a shared phone those differ, and that
condition would refuse a synced sale's payments, leaving it with none.
created_at is set by the database at sync time, so freshness is safe.
Residual accepted: a colleague's sale can gain a payment within its
first 15 minutes. The verification also re-checks, table-wide, that no
other permissive rule still opens edit/delete on sales or payments.


## All departments on Credit and Recovered debt

Both screens showed one department at a time. Now an "All departments"
chip is offered to everyone who sees all departments (OVERSIGHT), and
auditors OPEN on it — their default is the whole branch. Everyone else
still opens on their own department via startingDept().

The loaders already treated no department as the whole branch, so the
work was in the screens:
  - CREDIT: loadBalances returns one row per customer PER department
    per staff member. The all view COMBINES them — one line per
    customer, listing where they owe — so someone owing at two counters
    doesn't appear twice as two half-truths. Combined BEFORE filtering
    out settled accounts, so an overpayment at one department correctly
    reduces what they owe overall. The statement shows the whole ledger.
  - Record payment and Move to room are HIDDEN in the all view, with a
    note: a repayment must be credited to one department, and both fell
    back to locId — which in the all view is the literal 'all'.
  - The staff filter is hidden in the all view (it's built per
    department).
  - RECOVERY: rows already name their department, so only the chip,
    the starting choice and the loader changed.
The Day filter and guest room balances were already written for 'all'.

VERIFIED with the real combining code: two-counter debt combines
(1,000 + 500 = 1,500); an overpayment reduces the total (800 owed,
200 overpaid elsewhere = 600, listed at MainBar only); fully repaid
customers drop out; a customer across two staff combines; the
single-department view is unchanged.


## Adjusted counts need a second person (migration 259, decision C)

An auditor may still correct a line on a submitted count after a
recount, but NOBODY VERIFIES A COUNT THEY ADJUSTED:
  no adjusted lines  -> auditor, GM or admin verify (unchanged)
  any adjusted line  -> manager, GM or admin verify, never the adjuster

An earlier draft of 259 (written in a response that was lost; its files
survived) excluded only the auditor ROLE. But auditor_adjust_count_line
lets auditor, GM and admin adjust, so a GM could have corrected a line
and verified it themselves. Corrected: stock_count_lines.adjusted_by
records WHO adjusted, and verification refuses that person whatever
their role. Lines adjusted before 259 have no recorded adjuster; the
role rule still applies to them. 259 records itself under a new id
('..._v2') and its guards accept either verify version, so it applies
correctly even if the draft was ever run.

Also fixed: neither verify_stock_count nor auditor_adjust_count_line
checked the count's branch, and both run with elevated rights.
can_see_branch() added to both. Adjusting an item not on the count now
says so instead of silently changing nothing.

App: count lines load adjusted_by; Verify is hidden from whoever
adjusted, with "You adjusted a line on this count, so someone else must
verify it." VERIFIED app vs database across not-adjusted, adjusted by
auditor/GM/admin, and legacy lines, for every verifier: 0 mismatches.

DEPLOY ORDER: 259 FIRST, then this app. The app now loads adjusted_by;
before the column exists, count lines would fail to load.


## Manager bar and default location (migration 260)

Bar: Daily sales · Sales · Rooms · Credit · More, landing on Daily sales
(unchanged). Managers were split out of the shared MANAGEMENT bar in
lib/tabs.js; GM and admin are untouched.

Sales moved onto the bar because managers approve room charges, and the
approvals box lives on the Sales page's Reception view — previously
More -> Sales -> Reception. Counts stays in More: verifying adjusted
counts (decision C) is occasional, and the badge still points there.

Default location = Reception (260). Both managers had none. On Reception,
Sales opens on the close of day, in-house roster and approvals; Credit on
guest room balances and unlinked accounts. Checked first that each branch
has exactly one Reception that is a sales point and not a store —
otherwise startingDept() would silently fall back to another department.
Counts also opens new counts on the default; managers can pick any
department there, so it only pre-selects the choice.

VERIFIED by running the real old and new tab logic for every role: only
the manager changed, nobody lost a screen, no duplicates.
