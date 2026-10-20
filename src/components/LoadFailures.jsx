import { useEffect, useState } from 'react'
import { subscribeLoadFailures, clearAllLoadFailures } from '../lib/loadfail'
import Notice from './Notice'

// What did not load, said once at the top of the app rather than forty-five
// times inside forty-five lists (20 October 2026).
//
// The screens underneath still render their empty states, because a blank
// list is better than a blank page. This is what stops that blank list from
// being read as an answer.
export default function LoadFailures() {
  const [list, setList] = useState([])
  useEffect(() => subscribeLoadFailures(setList), [])
  if (!list.length) return null

  return (
    <div className="px-5 pt-3">
      <Notice tone="problem"
        title={list.length === 1
          ? 'Something on this screen did not load'
          : `${list.length} things did not load`}>
        <p>
          What you see below is missing them. An empty list here is not the same
          as nothing being there.
        </p>
        <ul className="mt-2 space-y-1">
          {list.map(f => (
            <li key={f.label} className="break-words">
              <b>{f.label}</b>
              <span className="block text-xs">{f.message}</span>
            </li>
          ))}
        </ul>
        <div className="flex gap-2 mt-3">
          <button type="button" onClick={() => window.location.reload()}
            className="h-10 px-4 rounded-xl bg-amber text-bg font-semibold">
            Try again
          </button>
          <button type="button" onClick={clearAllLoadFailures}
            className="h-10 px-4 rounded-xl border border-line text-dim">
            Dismiss
          </button>
        </div>
      </Notice>
    </div>
  )
}
