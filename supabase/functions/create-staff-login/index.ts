// Create a staff login, for a REPLACEMENT.
//
// When somebody leaves on a personal login the right answer is to
// switch it off and give their replacement their own account — never
// to rename the old one, because every entry names the ACCOUNT and
// renaming would make Chidera's November work read as Justin's.
//
// Until now there was no way to create an account from the app at all,
// so "switch off and make a new one" meant a session in the Supabase
// dashboard, and renaming looked like the easier road. That is the
// whole reason this exists (Chris, 26 November 2026).
//
// WHY THIS LIVES ON THE SERVER. Creating a user needs the service-role
// key, which must never reach a phone: anyone who extracted it could
// make themselves an admin. The key stays here, and the function
// checks who is asking before it acts.
//
// GM and admin accounts are NOT created here, deliberately — the same
// line reset-staff-password draws. Making a supervisor is a dashboard
// job.
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

const ALLOWED = ['bar', 'front_desk', 'storekeeper', 'manager', 'auditor', 'housekeeper']

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
      return json({ ok: false, error: 'Only a GM or admin can create a login' }, 403)
    }

    // ---- what are they asking for? ----
    const body = await req.json()
    const fullName = String(body.fullName || '').trim()
    const email = String(body.email || '').trim().toLowerCase()
    const password = String(body.password || '')
    const role = String(body.role || '').trim()
    const branchId = String(body.branchId || '').trim()
    const defaultLocationId = body.defaultLocationId || null

    if (!fullName) return json({ ok: false, error: 'Enter the name' }, 400)
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return json({ ok: false, error: 'Enter a valid sign-in address' }, 400)
    }
    if (password.length < 8) return json({ ok: false, error: 'Use at least 8 characters' }, 400)
    if (!ALLOWED.includes(role)) {
      return json({ ok: false, error: 'GM and admin logins are made in the Supabase dashboard, not here' }, 403)
    }
    // A GM works both branches, so the branch is passed rather than
    // taken from the caller — but only one they can actually see.
    if (!branchId) return json({ ok: false, error: 'Which branch is this login for?' }, 400)
    if (caller.role !== 'admin' && caller.branch_id !== branchId) {
      return json({ ok: false, error: 'That branch is not yours' }, 403)
    }

    // A name already in use at this branch is almost always somebody
    // keying a replacement under the leaver's name. Refuse and say so:
    // two active "Chidera" rows would make every entry ambiguous.
    const { data: clash } = await admin
      .from('staff').select('id, full_name')
      .eq('branch_id', branchId).eq('is_active', true)
      .ilike('full_name', fullName).limit(1).maybeSingle()
    if (clash) {
      return json({ ok: false,
        error: `There is already an active login called ${clash.full_name} at this branch. Switch that one off first, or use a different name.` }, 409)
    }

    // ---- create the login ----
    const { data: made, error: cErr } = await admin.auth.admin.createUser({
      email, password, email_confirm: true,
    })
    if (cErr || !made?.user) {
      const msg = String(cErr?.message || 'Could not create the login')
      return json({ ok: false,
        error: /already/i.test(msg) ? 'That sign-in address is already in use' : msg }, 400)
    }

    // The staff row's OWN id is the auth user's id: every account in
    // this database is wired that way and auth_user_id is empty
    // throughout. Sign-in matches on either, so following the existing
    // shape keeps the two kinds from drifting apart.
    const { data: row, error: sErr } = await admin.from('staff').insert({
      id: made.user.id,
      branch_id: branchId,
      full_name: fullName,
      role,
      default_location_id: defaultLocationId,
      is_active: true,
      note: `${new Date().toISOString().slice(0, 10)}: login created by ${caller.full_name}`,
    }).select('id, full_name, role').single()

    if (sErr) {
      // Leave no orphan. An auth user with no staff row cannot sign in
      // to anything, but it holds the address and the next attempt
      // would fail with "already in use" for no visible reason.
      await admin.auth.admin.deleteUser(made.user.id)
      return json({ ok: false, error: `Login not created: ${sErr.message}` }, 400)
    }

    return json({ ok: true, staff: row, email })
  } catch (e) {
    // 200 with ok:false, matching the other functions: the app shows
    // the message rather than a bare network failure.
    return json({ ok: false, error: String(e?.message || e) })
  }
})
