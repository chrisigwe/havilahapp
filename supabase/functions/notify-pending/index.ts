// Supabase Edge Function: notify-pending
//
// Sends a Web Push to every subscribed device whose branch has stock
// counts awaiting verification. Runs on a schedule (see README) rather
// than on a database trigger, so a single push carries the CURRENT
// count instead of one push per row inserted.
//
// Deploy:
//   supabase functions deploy notify-pending --no-verify-jwt
//   supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:you@example.com
//
// Then schedule it (SQL editor, pg_cron + pg_net):
//   select cron.schedule('notify-pending','*/5 * * * *', $$
//     select net.http_post(
//       url := '<PROJECT_URL>/functions/v1/notify-pending',
//       headers := '{"Authorization":"Bearer <SERVICE_ROLE_KEY>"}'::jsonb
//     ) $$);

import { createClient } from 'npm:@supabase/supabase-js@2'
import webpush from 'npm:web-push@3.6.7'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,   // bypasses RLS by design
)

// Deliberately NOT called at module scope. A throw up there kills the
// worker before any request is handled, and the caller only ever sees
// WORKER_ERROR with no reason. Called inside the handler instead, so
// the real cause can be returned in the response body.
function initVapid() {
  const subject = Deno.env.get('VAPID_SUBJECT')
  const pub = Deno.env.get('VAPID_PUBLIC_KEY')
  const priv = Deno.env.get('VAPID_PRIVATE_KEY')
  const missing = [
    !subject && 'VAPID_SUBJECT',
    !pub && 'VAPID_PUBLIC_KEY',
    !priv && 'VAPID_PRIVATE_KEY',
  ].filter(Boolean)
  if (missing.length) throw new Error('Missing secrets: ' + missing.join(', '))
  if (!subject!.startsWith('mailto:') && !subject!.startsWith('https://')) {
    throw new Error('VAPID_SUBJECT must start with "mailto:" or "https://" — got: ' + subject)
  }
  webpush.setVapidDetails(subject!, pub!, priv!)
}

Deno.serve(async () => {
 try {
  initVapid()
  // Pending verifications per branch — the same thing the in-app
  // badge counts, so the two never disagree.
  const { data: pending } = await supabase
    .from('stock_counts')
    .select('id, branch_id, location_id, counted_by, count_date, submitted_at')
    .eq('status', 'submitted')
    .order('submitted_at', { ascending: true })

  const byBranch: Record<string, number> = {}
  for (const r of pending ?? []) byBranch[r.branch_id] = (byBranch[r.branch_id] ?? 0) + 1

  // Names for the detail (Chris, 25 October 2026: "add more detail").
  // "2 stock counts waiting for verification" says there is work without
  // saying whose, where, or how long it has sat — so it reads the same
  // whether it is this morning's count or one from last week.
  //
  // Looked up separately rather than embedded in the select: an embed
  // needs a foreign key PostgREST can see, and a wrong guess here takes
  // the whole notification down silently for every device.
  const locIds = [...new Set((pending ?? []).map(r => r.location_id).filter(Boolean))]
  const staffIds = [...new Set((pending ?? []).map(r => r.counted_by).filter(Boolean))]
  const locName: Record<string, string> = {}
  const staffName: Record<string, string> = {}
  if (locIds.length) {
    const { data } = await supabase.from('stock_locations').select('id, name').in('id', locIds)
    for (const l of data ?? []) locName[l.id] = l.name
  }
  if (staffIds.length) {
    const { data } = await supabase.from('staff').select('id, full_name').in('id', staffIds)
    for (const w of data ?? []) staffName[w.id] = w.full_name
  }

  // First names only. A phone shows roughly 40 characters of a
  // notification before it truncates, and "Chidera" identifies the
  // person on a seven-person shift as well as the full name does.
  const firstName = (id: string | null) =>
    (id && staffName[id] ? staffName[id].split(' ')[0] : '')

  const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Lagos' }))
  const daysWaiting = (iso: string | null) => {
    if (!iso) return 0
    return Math.max(0, Math.round((today.getTime() - new Date(iso).getTime()) / 86400000))
  }
  const waitPhrase = (d: number) =>
    d <= 0 ? 'today' : d === 1 ? 'since yesterday' : `waiting ${d} days`

  // One line per count: where, who, how long. Oldest first, because the
  // oldest is the one that matters.
  const linesFor = (branch: string) => (pending ?? [])
    .filter(r => r.branch_id === branch)
    .map(r => [locName[r.location_id ?? ''] || 'A department',
               firstName(r.counted_by), waitPhrase(daysWaiting(r.submitted_at))]
      .filter(Boolean).join(' · '))

  const { data: subs } = await supabase
    .from('push_subscriptions')
    .select('endpoint, p256dh, auth, branch_id, staff_id, last_count, last_verified_seen')
    .is('failed_at', null)

  let sent = 0
  for (const s of subs ?? []) {
    const count = byBranch[s.branch_id] ?? 0

    // Only push when the backlog GREW. An unchanged count means the
    // person already knows; a falling one means someone is clearing
    // it. Either way, pushing again every 5 minutes is how a useful
    // alert becomes one people turn off. The row is still updated so
    // a later rise is measured from the true current value.
    if (count <= s.last_count) {
      if (count !== s.last_count) {
        await supabase.from('push_subscriptions')
          .update({ last_count: count }).eq('endpoint', s.endpoint)
      }
      continue
    }

    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({
          count,
          // The phone already prints "Havilah App" above every
          // notification, so a title of "Havilah App" wasted the one
          // line people actually read. The title now says the thing.
          title: count === 1 ? 'A stock count needs verifying'
                             : `${count} stock counts need verifying`,
          // Up to three named, then a count of the rest. A notification
          // that lists seven departments is one nobody finishes reading.
          body: linesFor(s.branch_id).slice(0, 3).join('\n')
                + (count > 3 ? `\n+ ${count - 3} more` : ''),
          tag: 'havilah-pending',
          url: '/?tab=count',
          action: 'Open counts',
        }),
      )
      sent++
      await supabase.from('push_subscriptions')
        .update({ last_sent_at: new Date().toISOString(), last_count: count })
        .eq('endpoint', s.endpoint)
    } catch (err) {
      // 404/410 mean the browser is gone for good — mark it so we
      // stop pushing to a dead endpoint forever.
      const code = (err as { statusCode?: number }).statusCode
      if (code === 404 || code === 410) {
        await supabase.from('push_subscriptions')
          .update({ failed_at: new Date().toISOString() }).eq('endpoint', s.endpoint)
      }
    }
  }
  // ---- second pass: "your count was verified" ----
  // Targets the person who DID the count, so it reaches bar and front
  // desk too — they never receive the pass above, which is about work
  // waiting for a verifier. Keyed on verified_at rather than a count,
  // because verifying one count while another ages out leaves a total
  // unchanged and the notification would be missed.
  let verifiedSent = 0
  for (const s of subs ?? []) {
    const since = s.last_verified_seen ?? new Date(0).toISOString()
    const { data: mine } = await supabase
      .from('stock_counts')
      .select('id, verified_at')
      .eq('counted_by', s.staff_id)
      .eq('status', 'verified')
      .gt('verified_at', since)
      .order('verified_at', { ascending: false })

    if (!mine || mine.length === 0) continue
    const newest = mine[0].verified_at

    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({
          count: mine.length,
          title: mine.length === 1 ? 'Your count was verified'
                                   : `${mine.length} of your counts were verified`,
          body: mine.length === 1
            ? 'Checked and accepted. Nothing further needed from you.'
            : 'All checked and accepted. Nothing further needed from you.',
          // Its own tag. Both messages shared 'havilah-pending', so a
          // verification REPLACED the notification about work still
          // waiting — the phone shows one per tag.
          tag: 'havilah-verified',
          url: '/?tab=count',
          action: 'Open counts',
        }),
      )
      verifiedSent++
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode
      if (code === 404 || code === 410) {
        await supabase.from('push_subscriptions')
          .update({ failed_at: new Date().toISOString() }).eq('endpoint', s.endpoint)
        continue
      }
    }
    // Advance the mark even if the send failed for a transient reason,
    // or a persistent error would re-announce the same verification
    // every five minutes forever.
    await supabase.from('push_subscriptions')
      .update({ last_verified_seen: newest }).eq('endpoint', s.endpoint)
  }

  return new Response(JSON.stringify({ ok: true, sent, verifiedSent }), {
    headers: { 'Content-Type': 'application/json' },
  })
 } catch (err) {
  // Returned as 200 ON PURPOSE: a 500 body is replaced by the
  // platform's generic WORKER_ERROR, which is what hid this in the
  // first place. 200 with ok:false gets the real message back to
  // net._http_response where it can actually be read.
  return new Response(JSON.stringify({
    ok: false,
    error: (err as Error)?.message ?? String(err),
    stack: (err as Error)?.stack?.split('\n').slice(0, 3).join(' | '),
  }), { headers: { 'Content-Type': 'application/json' } })
 }
})
