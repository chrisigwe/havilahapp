import { useState } from 'react'
import { supabase } from '../lib/supabase'
import Logo from '../components/Logo'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  async function submit() {
    setBusy(true); setErr(null)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) setErr('Wrong email or password.')
    setBusy(false)
  }

  return (
    <div className="min-h-dvh flex flex-col justify-center px-6 max-w-sm mx-auto">
      <div className="flex items-center gap-4">
        <Logo className="w-14 h-14 shrink-0 text-amber" />
        <h1 className="text-[2.3rem] leading-none font-bold tracking-tight">
          Havilah<span className="text-amber"> Inventory</span>
        </h1>
      </div>
      <p className="mt-2 text-dim">Sign in to record sales and stock.</p>
      <div className="mt-10 space-y-4">
        <input value={email} onChange={e => setEmail(e.target.value)} type="email" inputMode="email"
          autoComplete="username" placeholder="Email"
          className="w-full h-14 px-4 rounded-xl bg-surface border border-line placeholder:text-dim" />
        <input value={password} onChange={e => setPassword(e.target.value)} type="password"
          autoComplete="current-password" placeholder="Password"
          onKeyDown={e => e.key === 'Enter' && submit()}
          className="w-full h-14 px-4 rounded-xl bg-surface border border-line placeholder:text-dim" />
        {err && <p className="text-clay">{err}</p>}
        <button onClick={submit} disabled={busy || !email || !password}
          className="w-full h-14 rounded-xl bg-amber text-bg font-bold text-lg disabled:opacity-40">
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </div>
    </div>
  )
}
