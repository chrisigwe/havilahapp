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

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import webpush from 'https://esm.sh/web-push@3.6.7'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,   // bypasses RLS by design
)

webpush.setVapidDetails(
  Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@example.com',
  Deno.env.get('VAPID_PUBLIC_KEY')!,
  Deno.env.get('VAPID_PRIVATE_KEY')!,
)

Deno.serve(async () => {
  // Pending verifications per branch — the same thing the in-app
  // badge counts, so the two never disagree.
  const { data: pending } = await supabase
    .from('stock_counts')
    .select('branch_id')
    .eq('status', 'submitted')

  const byBranch: Record<string, number> = {}
  for (const r of pending ?? []) byBranch[r.branch_id] = (byBranch[r.branch_id] ?? 0) + 1

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
          title: 'Havilah App',
          body: `${count} stock count${count === 1 ? '' : 's'} waiting for verification.`,
          url: '/',
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
          title: 'Count verified',
          body: mine.length === 1
            ? 'Your stock count has been verified.'
            : `${mine.length} of your stock counts have been verified.`,
          url: '/',
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

  return new Response(JSON.stringify({ sent, verifiedSent }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
