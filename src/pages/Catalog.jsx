import { useEffect, useMemo, useState } from 'react'
import { naira } from '../lib/format'
import { saveItemPrices, createItem, loadAllCatalogItems, deleteCatalogItem } from '../lib/data'
import { useToast } from '../components/Toast'
import Notice from '../components/Notice'

export default function Catalog({ boot, onChanged }) {
  const { staff, tiers } = boot
  const toast = useToast()
  const [all, setAll] = useState(null)     // active + inactive, fetched separately from boot.items
  const [q, setQ] = useState('')
  const [show, setShow] = useState('active')   // active | inactive | all
  const [edit, setEdit] = useState(null)
  const [adding, setAdding] = useState(null)
  const [confirmDel, setConfirmDel] = useState(null)
  const [loadErr, setLoadErr] = useState(null)
  const [busy, setBusy] = useState(false)

  // A failed load used to set the list to empty, so the catalogue read
  // as "no items" — a claim about the business, from a request that did
  // not arrive (20 October 2026).
  const refreshAll = () => {
    loadAllCatalogItems(staff.branch_id)
      .then(a => { setAll(a); setLoadErr(null) })
      .catch(e => setLoadErr(e.message || 'could not load'))
  }
  useEffect(refreshAll, [staff.branch_id])

  // switching branches (GM/admin) re-renders this component with new
  // data rather than remounting it — clear anything referencing the
  // OLD branch's items so a stale id can never be acted on after the
  // switch (an open edit sheet, a pending delete confirmation, a
  // half-typed "add new item" form)
  useEffect(() => {
    setAll(null)
    setEdit(null); setAdding(null); setConfirmDel(null)
  }, [staff.branch_id])

  const list = useMemo(() => {
    if (!all) return []
    const n = q.trim().toLowerCase()
    return all
      .filter(i => i && typeof i.name === 'string')   // never let one bad row blank the screen
      .filter(i => show === 'all' || (show === 'active') === !!i.is_active)
      .filter(i => !n || i.name.toLowerCase().includes(n))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [all, q, show])

  const brokenCount = (all || []).filter(i => !i || typeof i.name !== 'string').length

  async function save() {
    setBusy(true)
    try {
      const patch = {
        name: edit.name.trim(),
        selling_price: Number(edit.selling_price) || 0,
        lounge_price: edit.lounge_price === '' ? null : Number(edit.lounge_price),
        staff_price: edit.staff_price === '' ? null : Number(edit.staff_price),
        cost_price: edit.cost_price === '' ? null : Number(edit.cost_price),
        is_active: edit.is_active,
        is_consumable: !!edit.is_consumable,
        // Pack settings (575). All three move together: the database
        // refuses a size with no name, so clearing one clears the lot
        // rather than leaving half a setting behind that nothing can
        // save afterwards.
        ...(Number(edit.pack_size) > 1 && String(edit.pack_label || '').trim()
          ? { pack_label: String(edit.pack_label).trim(),
              pack_size: Number(edit.pack_size),
              piece_item_id: edit.piece_item_id || null }
          : { pack_label: null, pack_size: null, piece_item_id: null }),
      }
      await saveItemPrices(edit.id, patch)
      toast('Saved', 'success'); setEdit(null); refreshAll(); onChanged?.()
    } catch (e) { toast('Not saved: ' + e.message, 'error') }
    setBusy(false)
  }

  async function doDelete() {
    setBusy(true)
    try {
      await deleteCatalogItem(confirmDel.id)
      toast('Item deleted', 'success'); setConfirmDel(null); setEdit(null); refreshAll(); onChanged?.()
    } catch (e) { toast(e.message, 'error') }
    setBusy(false)
  }

  async function add() {
    setBusy(true)
    try {
      const nm = adding.name.trim()
      // stock code is no longer shown or entered — auto-generate a
      // stable-ish one from the name plus a short random suffix so the
      // column stays populated and unique without the user seeing it
      const autoCode = (nm.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase() || 'ITEM')
        + '-' + Math.random().toString(36).slice(2, 6).toUpperCase()
      await createItem(staff.branch_id, {
        code: autoCode,
        name: nm,
        selling_price: Number(adding.selling_price) || 0,
        lounge_price: adding.lounge_price === '' ? null : Number(adding.lounge_price),
        cost_price: adding.cost_price === '' ? null : Number(adding.cost_price),
        is_active: true,
      })
      toast('Item added', 'success'); setAdding(null); refreshAll(); onChanged?.()
    } catch (e) { toast('Not added: ' + e.message, 'error') }
    setBusy(false)
  }

  return (
    <div className="px-5">
      <div className="flex gap-2 py-2">
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search items"
          className="flex-1 h-12 px-4 rounded-xl bg-surface border border-line placeholder:text-dim" />
        <button onClick={() => setAdding({ name: '', selling_price: '', lounge_price: '', cost_price: '' })}
          className="h-12 px-4 rounded-xl bg-amber text-bg font-bold">+ New</button>
      </div>
      <div className="flex gap-2 pb-2">
        {[['active', 'Active'], ['inactive', 'Inactive'], ['all', 'All']].map(([k, label]) => (
          <button key={k} onClick={() => setShow(k)}
            className={`h-9 px-3 rounded-full border text-sm ${show === k
              ? 'bg-raise border-amber text-amber font-bold' : 'border-line text-dim'}`}>
            {label}
          </button>
        ))}
      </div>

      {loadErr && (
        <Notice tone="problem" title="The catalogue could not be loaded">
          <p>This is not an empty catalogue — the list did not arrive. Tell the GM.</p>
          <p className="text-xs mt-2 break-words">{loadErr}</p>
        </Notice>
      )}

      {/* What is in the catalogue, before the list of it. Prices are
          what this page is for, so the span is named too. */}
      {!loadErr && !!all?.length && (() => {
        const active = all.filter(i => i?.is_active).length
        const priced = list.filter(i => Number(i.selling_price) > 0).length
        return (
          <section className="rounded-2xl border border-line bg-surface p-4 mb-3">
            <div className="text-dim text-sm">
              {show === 'active' ? 'Active items' : show === 'inactive' ? 'Inactive items' : 'All items'}
            </div>
            <div className="tnum text-2xl font-bold">{list.length}</div>
            <div className="text-dim text-sm mt-1">
              {active} active of {all.length} in all
              {priced < list.length && (
                <span className="text-amber"> · {list.length - priced} with no selling price</span>
              )}
            </div>
          </section>
        )
      })()}

      <ul className="divide-y divide-line/60">
        {list.map(i => (
          <li key={i.id}>
            <button onClick={() => setEdit({ ...i,
              lounge_price: i.lounge_price ?? '', staff_price: i.staff_price ?? '',
              cost_price: i.cost_price ?? '' })}
              className="w-full text-left py-3 flex items-center gap-3">
              <span className={`flex-1 min-w-0 truncate font-semibold ${!i.is_active ? 'text-dim line-through' : ''}`}>
                {i.name}
              </span>
              {i.cost_price != null && (
                <span className="text-dim text-sm tnum">cost {naira(i.cost_price)}</span>
              )}
              <span className="tnum">{naira(i.selling_price ?? 0)}</span>
            </button>
          </li>
        ))}
        {!loadErr && all && !list.length && (
          <li className="py-8 text-center text-dim">
            {q.trim() ? `Nothing matches “${q.trim()}”.`
              : show === 'inactive' ? 'Nothing has been switched off.'
              : 'No items in the catalogue yet.'}
          </li>
        )}
        {!all && !loadErr && <li className="py-8 text-center text-dim">Loading…</li>}
      </ul>
      {brokenCount > 0 && (
        <p className="mt-3 text-clay text-sm">
          {brokenCount} item{brokenCount > 1 ? 's' : ''} could not be displayed — bad data
          in the catalog. Tell your developer rather than ignore this.
        </p>
      )}

      {(edit || adding) && (
        <div className="fixed inset-0 z-50 bg-bg h-[100dvh] flex flex-col">
          <div className="p-5 flex-1 min-h-0 overflow-y-auto">
            <button onClick={() => { setEdit(null); setAdding(null) }} className="text-dim">Back</button>
            <h2 className="mt-3 text-2xl font-bold">{edit ? edit.name : 'New item'}</h2>

            <Field label="Name">
              <input value={edit ? edit.name : adding.name}
                onChange={e => edit ? setEdit(x => ({ ...x, name: e.target.value }))
                                    : setAdding(a => ({ ...a, name: e.target.value }))}
                className="h-14 w-full px-4 rounded-xl bg-surface border border-line" />
            </Field>

            <Field label="Selling price">
              <Num value={edit ? edit.selling_price : adding.selling_price}
                onChange={v => edit ? setEdit(x => ({ ...x, selling_price: v }))
                                    : setAdding(a => ({ ...a, selling_price: v }))} />
            </Field>

            {tiers.includes('lounge') && (
              <Field label="Lounge price">
                <Num value={edit ? edit.lounge_price : adding.lounge_price}
                  onChange={v => edit ? setEdit(x => ({ ...x, lounge_price: v }))
                                      : setAdding(a => ({ ...a, lounge_price: v }))} />
              </Field>
            )}

            {edit && tiers.includes('staff') && (
              <Field label="Staff price (blank = uses selling price)">
                <Num value={edit.staff_price} onChange={v => setEdit(x => ({ ...x, staff_price: v }))} />
              </Field>
            )}

            <Field label="Cost price (what you pay for it)">
              <Num value={edit ? edit.cost_price : adding.cost_price}
                onChange={v => edit ? setEdit(x => ({ ...x, cost_price: v }))
                                    : setAdding(a => ({ ...a, cost_price: v }))} />
            </Field>

            {edit && (
              <>
                {/* How it arrives, and what it becomes (Chris, 25 October
                    2026). Blank means it is received the same way it is
                    sold, which is true of most things here. */}
                <Field label="Received in packs? (leave blank if not)">
                  <div className="flex gap-3">
                    <input type="text" placeholder="crate" value={edit.pack_label ?? ''}
                      onChange={e => setEdit(x => ({ ...x, pack_label: e.target.value }))}
                      className="h-14 flex-1 min-w-0 px-4 rounded-xl bg-surface border border-line" />
                    <input type="number" inputMode="numeric" placeholder="12"
                      value={edit.pack_size ?? ''}
                      onChange={e => setEdit(x => ({ ...x, pack_size: e.target.value }))}
                      className="h-14 w-28 px-4 rounded-xl bg-surface border border-line tnum" />
                  </div>
                  <p className="text-dim text-sm mt-2">
                    A crate of 12. Receiving 5 crates then records 60 — the Store
                    page shows the sum before you save it.
                  </p>
                </Field>

                {Number(edit.pack_size) > 1 && (
                  <Field label="Does the pack itself sit on the book?">
                    <select value={edit.piece_item_id || ''}
                      onChange={e => setEdit(x => ({ ...x, piece_item_id: e.target.value || null }))}
                      className="h-14 w-full px-3 rounded-xl bg-surface border border-line">
                      <option value="">No — the {edit.pack_label || 'pack'} is only how we count it in</option>
                      {(all || [])
                        .filter(i => i && i.id !== edit.id && i.is_active && typeof i.name === 'string')
                        .sort((a, b) => a.name.localeCompare(b.name))
                        .map(i => (
                          <option key={i.id} value={i.id}>Yes — one becomes {edit.pack_size} × {i.name}</option>
                        ))}
                    </select>
                    <p className="text-dim text-sm mt-2">
                      Only for something you stock both ways — a bottle of groundnut
                      you hold as bottles and open into plates. Pick the piece and
                      Convert fills the rest in for you.
                    </p>
                  </Field>
                )}

                <label className="mt-6 flex items-center gap-3">
                  <input type="checkbox" checked={edit.is_active} className="w-5 h-5"
                    onChange={e => setEdit(x => ({ ...x, is_active: e.target.checked }))} />
                  <span>Active — appears when recording sales</span>
                </label>
                <label className="mt-4 flex items-center gap-3">
                  <input type="checkbox" checked={!!edit.is_consumable} className="w-5 h-5"
                    onChange={e => setEdit(x => ({ ...x, is_consumable: e.target.checked }))} />
                  <span>Supply — used up, not sold (staff must log each use with a note)</span>
                </label>
                <button onClick={() => setConfirmDel(edit)}
                  className="mt-6 w-full h-12 rounded-xl border border-clay text-clay font-semibold">
                  Delete permanently
                </button>
                <p className="text-dim text-sm mt-2">
                  Only works if this item has never been sold, moved, or counted.
                  Otherwise, turn off "Active" instead — that hides it everywhere
                  without touching its history.
                </p>
              </>
            )}
          </div>
          <div className="p-5 border-t border-line">
            <button onClick={edit ? save : add} disabled={busy}
              className="w-full h-16 rounded-2xl bg-amber text-bg text-xl font-bold disabled:opacity-40">
              {busy ? 'Saving…' : edit ? 'Save changes' : 'Add item'}
            </button>
          </div>
        </div>
      )}
      {confirmDel && (
        <div className="fixed inset-0 z-[60] bg-bg flex flex-col justify-center px-6">
          <h2 className="text-2xl font-bold">Delete "{confirmDel.name}"?</h2>
          <p className="text-dim mt-2">
            This only succeeds if the item has no sales, movements, or counts
            against it anywhere. If it does, you'll get an error explaining why —
            deactivate it instead in that case.
          </p>
          <button onClick={doDelete} disabled={busy}
            className="mt-6 w-full h-14 rounded-2xl bg-clay text-bg text-lg font-bold disabled:opacity-40">
            {busy ? 'Deleting…' : 'Delete permanently'}
          </button>
          <button onClick={() => setConfirmDel(null)} className="mt-3 w-full h-12 text-dim">Cancel</button>
        </div>
      )}
    </div>
  )
}

const Field = ({ label, children }) => (
  <div className="mt-5"><div className="text-dim mb-2">{label}</div>{children}</div>
)
const Num = ({ value, onChange }) => (
  <input type="number" inputMode="decimal" value={value}
    onChange={e => onChange(e.target.value)}
    className="h-14 w-full px-4 rounded-xl bg-surface border border-line tnum" />
)
