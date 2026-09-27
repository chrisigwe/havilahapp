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
    .select('endpoint, p256dh, auth, branch_id')
    .is('failed_at', null)

  let sent = 0
  for (const s of subs ?? []) {
    const count = byBranch[s.branch_id] ?? 0
    if (count === 0) continue          // nothing to say; stay quiet

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
        .update({ last_sent_at: new Date().toISOString() }).eq('endpoint', s.endpoint)
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
  return new Response(JSON.stringify({ sent }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
