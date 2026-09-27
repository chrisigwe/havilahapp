// Read-only accounts (e.g. the demo login, a manager set to observe
// only) are enforced server side by the block_if_read_only trigger
// from migration 155, which raises a readable message. The gap this
// closes is that the restriction was invisible until someone had
// already filled in a form and pressed save — the flag was fetched in
// the boot payload and then never used anywhere in the UI.
//
// Deliberately a banner rather than disabling every control: these
// accounts exist to browse the whole app, and blanket-disabling
// buttons would also block navigation into folios, receipts and
// statements, which they are meant to be able to open.
export default function ReadOnlyBanner({ readOnly }) {
  if (!readOnly) return null
  return (
    <div className="px-5 py-2 bg-dim/10 border-b border-line flex items-center gap-2">
      <span className="text-sm">👁</span>
      <p className="text-dim text-sm">
        View-only account — you can open everything, but changes won't save.
      </p>
    </div>
  )
}
