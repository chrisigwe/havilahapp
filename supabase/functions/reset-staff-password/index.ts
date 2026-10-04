// Reset a staff account's password, for a HANDOVER.
//
// Several logins are ROLE accounts, not personal ones —
// chef.awka@havilah.local, nnewi.auditor@havilah.local. When the chef
// leaves, a new chef takes over the same account, so deactivating is
// wrong: the account continues, the person changes. What is needed is a
// new password (so the person who left cannot sign in) and a record of
// who holds it now.
//
// WHY THIS LIVES ON THE SERVER. Changing someone else's password needs
// the service-role key, which must never be in a phone app: anyone who
// extracted it could reset ANY account, the GM's included. Here the key
// stays on the server, and the function does two things before it will
// act:
//   1. verifies the CALLER's own token and looks up their staff row
//   2. refuses unless that row is an active gm/admin
// So a stolen app build gets nobody anywhere without a GM's own login.
//
// It also refuses to reset a gm/admin account — one supervisor must not
// be able to lock another out. Those go through the Supabase dashboard,
// deliberately.
import { createClient } from 'npm:@supabase/supabase-js@2'

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json',
               'Access-Control-Allow-Origin': '*',
               'Access-Control-Allow-Headers': 'authorization, content-type' },
  })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return json({ ok: true })

  try {
    // ---- who is asking? ----
    const token = req.headers.get('Authorization')?.replace('Bearer ', '')
    if (!token) return json({ ok: false, error: 'Not signed in' }, 401)

    const { data: { user }, error: uErr } = await admin.auth.getUser(token)
    if (uErr || !user) return json({ ok: false, error: 'Not signed in' }, 401)

    const { data: caller } = await admin
      .from('staff').select('id, role, is_active, branch_id, full_name')
      .or(`auth_user_id.eq.${user.id},id.eq.${user.id}`)
      .eq('is_active', true).limit(1).maybeSingle()

    if (!caller || !['gm', 'admin'].includes(caller.role)) {
      return json({ ok: false, error: 'Only a GM or admin can reset a password' }, 403)
    }

    // ---- what are they asking for? ----
    const { staffId, newPassword, newHolderName } = await req.json()
    if (!staffId || !newPassword) {
      return json({ ok: false, error: 'Missing staff member or password' }, 400)
    }
    if (String(newPassword).length < 8) {
      return json({ ok: false, error: 'Use at least 8 characters' }, 400)
    }

    const { data: target } = await admin
      .from('staff').select('id, auth_user_id, role, full_name, branch_id')
      .eq('id', staffId).maybeSingle()
    // Accounts are linked by the STAFF ROW'S OWN ID, not auth_user_id —
    // all 22 are that way and auth_user_id is empty throughout. Sign-in
    // matches on either, so this resolves the same way rather than
    // assuming the column is populated.
    const authId = target?.auth_user_id || target?.id
    if (!target) return json({ ok: false, error: 'Staff member not found' }, 404)

    // One supervisor must not be able to lock another out.
    if (['gm', 'admin'].includes(target.role)) {
      return json({ ok: false,
        error: 'GM and admin passwords are changed in the Supabase dashboard, not here' }, 403)
    }
    // Confirm the login actually exists before claiming to reset it.
    const { data: authUser } = await admin.auth.admin.getUserById(authId)
    if (!authUser?.user) {
      return json({ ok: false, error: 'That staff member has no login to reset' }, 400)
    }

    const { error: pErr } = await admin.auth.admin
      .updateUserById(authId, { password: String(newPassword) })
    if (pErr) return json({ ok: false, error: pErr.message }, 400)

    // Record the handover. The account name stays the same (it is a role
    // account); this says WHO holds it now and from when, so History
    // entries can still be read back to a person.
    const stamp = new Date().toISOString().slice(0, 10)
    const note = newHolderName
      ? `${stamp}: handed over to ${newHolderName} (by ${caller.full_name})`
      : `${stamp}: password reset by ${caller.full_name}`
    const { data: existing } = await admin
      .from('staff').select('note').eq('id', staffId).maybeSingle()
    await admin.from('staff')
      .update({ note: [existing?.note, note].filter(Boolean).join('\n') })
      .eq('id', staffId)

    return json({ ok: true, staff: target.full_name })
  } catch (e) {
    // 200 with ok:false, matching notify-pending: the app shows the
    // message rather than a bare network failure.
    return json({ ok: false, error: String(e?.message || e) })
  }
})
