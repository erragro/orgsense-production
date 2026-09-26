/**
 * Policy Studio pieces for what a proposal knows beyond its rules:
 *
 * - the business line (use case) it is written for,
 * - gaps: customer problems the SOP describes that the live taxonomy has no
 *   code for (Policy Studio never creates codes; a taxonomy admin does),
 * - knowledge passages, reviewed like any other AI proposal, with the
 *   {{variables}} they embed,
 * - the reviewer corrections the next extraction is given (lessons),
 * - the reason every correction carries.
 */

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle, ArrowLeft, ArrowRight, BookOpen, Check, Eye, Loader2, Pencil, Plus,
  Quote, Save, Sparkles, Trash2,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { apiErrorMessage } from '@/lib/api-error'
import {
  bpmApi,
  type ChunkPurpose,
  type KnowledgeChunk,
  type LiveIssue,
  type TaxonomyGap,
} from '@/api/governance/bpm.api'

export const inp = 'w-full px-2.5 py-1.5 rounded-lg border border-surface-border bg-surface text-sm text-foreground placeholder:text-foreground/70 focus:outline-none focus:ring-1 focus:ring-brand-500'
/** Matches MIN_REASON_CHARS in bpm_routes.py. */
export const MIN_REASON = 3

const PURPOSE_LABEL: Record<ChunkPurpose, string> = {
  decision: 'Guides the decision',
  response: 'Reply text',
  both: 'Decision and reply',
}

// ============================================================
// Shared pieces
// ============================================================

export function ReasonField({ value, onChange, label = 'Why? (the AI learns from this)' }: {
  value: string; onChange: (value: string) => void; label?: string
}) {
  return <label className="block text-xs text-foreground/70">{label}
    <input className={inp + ' mt-0.5'} maxLength={2000} value={value} onChange={e => onChange(e.target.value)}
      placeholder="e.g. The SOP only allows this for first claims" />
  </label>
}

/** A button that asks for a reason before it acts. */
export function ReasonAction({ label, title, icon, onConfirm, pending, tone = 'danger' }: {
  label: string; title: string; icon: React.ReactNode; onConfirm: (reason: string) => void
  pending?: boolean; tone?: 'danger' | 'neutral'
}) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  if (!open) {
    return <button onClick={() => setOpen(true)} disabled={pending} title={title} aria-label={title}
      className={cn('p-1.5 rounded-lg text-foreground/70 transition-colors disabled:opacity-40',
        tone === 'danger' ? 'hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/10' : 'hover:text-brand-500 hover:bg-surface')}>
      {icon}
    </button>
  }
  return <div className="flex items-end gap-1.5 w-full sm:w-72">
    <div className="flex-1"><ReasonField value={reason} onChange={setReason} /></div>
    <button onClick={() => { setOpen(false); setReason('') }} className="px-2 py-1 text-xs border border-surface-border rounded-lg">Cancel</button>
    <button onClick={() => { onConfirm(reason.trim()); setOpen(false); setReason('') }}
      disabled={reason.trim().length < MIN_REASON || pending}
      className="px-2 py-1 text-xs bg-red-600 text-white rounded-lg disabled:opacity-40">{label}</button>
  </div>
}

export function SourceQuote({ excerpt, verified }: { excerpt?: string | null; verified?: boolean | null }) {
  if (!excerpt) return null
  return <blockquote className="mt-1.5 flex gap-1.5 text-xs text-foreground/70 border-l-2 border-surface-border pl-2">
    <Quote className="w-3 h-3 shrink-0 mt-0.5" aria-hidden />
    <span><span className="italic">{excerpt}</span>
      {verified === false && <span className="ml-1.5 text-amber-700 dark:text-amber-400">(not found word for word in the SOP; check it)</span>}
      {verified === true && <span className="ml-1.5 text-green-700 dark:text-green-400">(found in the SOP)</span>}
    </span>
  </blockquote>
}

export function BusinessLineField({ kbId, value, onChange }: {
  kbId: string; value: string; onChange: (value: string) => void
}) {
  const lines = useQuery({
    queryKey: ['bpm', 'business-lines', kbId],
    queryFn: () => bpmApi.listBusinessLines(kbId).then(r => r.data.business_lines),
  })
  return <label className="block text-sm font-medium">Business line
    <input className={inp + ' mt-1'} list="policy-business-lines" maxLength={50} value={value}
      onChange={e => onChange(e.target.value)} placeholder="Leave empty for every business line" />
    <datalist id="policy-business-lines">{(lines.data ?? []).map(line => <option key={line} value={line} />)}</datalist>
    <span className="block text-xs text-foreground/70 font-normal mt-1">
      Decisions apply only to tickets from this business line. Corrections you make are remembered for it, and shared across the knowledge base.
    </span>
  </label>
}

// ============================================================
// Lessons
// ============================================================

export function LessonsPanel({ kbId, businessLine }: { kbId: string; businessLine?: string | null }) {
  const lessons = useQuery({
    queryKey: ['bpm', 'lessons', kbId, businessLine ?? ''],
    queryFn: () => bpmApi.listLessons(kbId, businessLine).then(r => r.data.lessons),
  })
  const rows = lessons.data ?? []
  return <details className="rounded-xl border border-surface-border p-4 text-sm">
    <summary className="cursor-pointer font-medium flex items-center gap-2">
      <BookOpen className="w-4 h-4" aria-hidden /> What the AI has learned from reviewers ({rows.length})
    </summary>
    <p className="text-xs text-foreground/70 mt-2">
      Every analysis is given these corrections, {businessLine ? `${businessLine} first, then` : 'including'} those from the rest of this knowledge base.
    </p>
    {lessons.isError && <p role="alert" className="text-xs text-red-600 mt-2">{apiErrorMessage(lessons.error, 'Lessons could not be loaded.')}</p>}
    {rows.length === 0 && lessons.isSuccess && <p className="text-xs text-foreground/70 mt-2">No corrections yet.</p>}
    <ul className="mt-2 space-y-1">
      {rows.map(lesson => <li key={lesson.id} className="text-xs">
        {!lesson.same_line && <span className="mr-1 px-1 rounded bg-surface border border-surface-border">shared</span>}
        {lesson.summary.replace(/^- /, '')}
      </li>)}
    </ul>
  </details>
}

// ============================================================
// Taxonomy gaps
// ============================================================

function GapRow({ kbId, gap, issues, onChanged }: {
  kbId: string; gap: TaxonomyGap; issues: LiveIssue[]; onChanged: () => void
}) {
  const [code, setCode] = useState('')
  const [note, setNote] = useState('')
  const resolve = useMutation({
    mutationFn: (action: 'map' | 'dismiss' | 'reopen') =>
      bpmApi.resolveTaxonomyGap(kbId, gap.id, { action, issue_code: action === 'map' ? code : undefined, note: note.trim() || undefined }),
    onSuccess: () => { setNote(''); onChanged() },
  })
  const open = gap.status === 'open'
  return <li className="border border-surface-border rounded-xl p-3 space-y-2">
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-sm font-medium">{gap.label}</span>
      {gap.suggested_code && <span className="text-xs font-mono text-foreground/70">suggested: {gap.suggested_code}</span>}
      <span className={cn('text-xs px-1.5 py-0.5 rounded-full',
        open ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700' : 'bg-surface border border-surface-border text-foreground/70')}>
        {open ? 'No code in your taxonomy' : gap.status === 'mapped' ? `Mapped to ${gap.mapped_issue_code}` : 'Not needed'}
      </span>
    </div>
    {gap.description && <p className="text-xs text-foreground/70">{gap.description}</p>}
    <SourceQuote excerpt={gap.source_excerpt} />
    {!open && gap.resolution_note && <p className="text-xs text-foreground/70">Reason: {gap.resolution_note}</p>}
    {open ? <div className="grid sm:grid-cols-[1fr_1fr_auto_auto] gap-2 items-end">
      <label className="text-xs text-foreground/70">Existing problem that covers it
        <select className={inp + ' mt-0.5'} value={code} onChange={e => setCode(e.target.value)}>
          <option value="">Choose…</option>
          {issues.map(i => <option key={i.issue_code} value={i.issue_code}>{i.label} ({i.issue_code})</option>)}
        </select>
      </label>
      <ReasonField value={note} onChange={setNote} />
      <button onClick={() => resolve.mutate('map')} disabled={!code || note.trim().length < MIN_REASON || resolve.isPending}
        className="px-3 py-1.5 text-xs bg-brand-600 text-white rounded-lg disabled:opacity-40">Map</button>
      <button onClick={() => resolve.mutate('dismiss')} disabled={note.trim().length < MIN_REASON || resolve.isPending}
        className="px-3 py-1.5 text-xs border border-surface-border rounded-lg disabled:opacity-40">Not needed</button>
    </div> : <button onClick={() => resolve.mutate('reopen')} className="text-xs underline">Reopen</button>}
    {resolve.isError && <p role="alert" className="text-xs text-red-600">{apiErrorMessage(resolve.error, 'Could not save this decision.')}</p>}
  </li>
}

export function TaxonomyGapsPanel({ kbId, entityId, onChanged }: {
  kbId: string; entityId: string; onChanged: () => void
}) {
  const qc = useQueryClient()
  const key = ['bpm', 'gaps', kbId, entityId]
  const gaps = useQuery({ queryKey: key, queryFn: () => bpmApi.listTaxonomyGaps(kbId, { entity_id: entityId }).then(r => r.data) })
  const issues = useQuery({ queryKey: ['bpm', 'live-taxonomy', kbId], queryFn: () => bpmApi.getLiveTaxonomy(kbId).then(r => r.data) })
  const rows = gaps.data ?? []
  if (!rows.length) return null
  const changed = () => { qc.invalidateQueries({ queryKey: key }); onChanged() }
  return <section aria-label="Problems your taxonomy does not cover" className="rounded-xl border border-amber-300 dark:border-amber-700 p-4 space-y-3">
    <div>
      <h3 className="text-sm font-semibold flex items-center gap-2"><AlertTriangle className="w-4 h-4 text-amber-600" aria-hidden />
        Problems your taxonomy does not cover ({rows.filter(g => g.status === 'open').length} open)</h3>
      <p className="text-xs text-foreground/70 mt-1">
        Policy Studio only maps SOPs onto your existing issue taxonomy, so every decision is one the live classifier can reach.
        Ask a taxonomy administrator to add a code for a problem you need, then map it here. Until then no decision can be written for it.
      </p>
    </div>
    <ul className="space-y-2">{rows.map(gap => <GapRow key={gap.id} kbId={kbId} gap={gap} issues={issues.data ?? []} onChanged={changed} />)}</ul>
  </section>
}

// ============================================================
// Knowledge passages
// ============================================================

function IssuePicker({ codes, value, onChange }: { codes: string[]; value: string[]; onChange: (codes: string[]) => void }) {
  return <fieldset className="text-xs text-foreground/70">
    <legend>Applies to (none selected: every problem)</legend>
    <div className="flex flex-wrap gap-2 mt-1">
      {codes.map(code => <label key={code} className="flex items-center gap-1">
        <input type="checkbox" checked={value.includes(code)}
          onChange={e => onChange(e.target.checked ? [...value, code] : value.filter(c => c !== code))} />
        <span className="font-mono">{code}</span>
      </label>)}
    </div>
  </fieldset>
}

type ChunkDraft = { title: string; body: string; purpose: ChunkPurpose; issue_codes: string[]; reason: string }

function ChunkFields({ draft, setDraft, codes }: { draft: ChunkDraft; setDraft: (d: ChunkDraft) => void; codes: string[] }) {
  return <div className="space-y-2">
    <label className="block text-xs text-foreground/70">Title
      <input className={inp + ' mt-0.5'} maxLength={200} value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} />
    </label>
    <label className="block text-xs text-foreground/70">Text — use {'{{variable}}'} for tenant values and ticket details
      <textarea className={cn(inp, 'mt-0.5 min-h-[80px]')} maxLength={4000} value={draft.body} onChange={e => setDraft({ ...draft, body: e.target.value })} />
    </label>
    <label className="block text-xs text-foreground/70">Used for
      <select className={inp + ' mt-0.5'} value={draft.purpose} onChange={e => setDraft({ ...draft, purpose: e.target.value as ChunkPurpose })}>
        {(Object.keys(PURPOSE_LABEL) as ChunkPurpose[]).map(p => <option key={p} value={p}>{PURPOSE_LABEL[p]}</option>)}
      </select>
    </label>
    <IssuePicker codes={codes} value={draft.issue_codes} onChange={issue_codes => setDraft({ ...draft, issue_codes })} />
    <ReasonField value={draft.reason} onChange={reason => setDraft({ ...draft, reason })} />
  </div>
}

function ChunkCard({ kbId, chunk, codes, onChanged }: {
  kbId: string; chunk: KnowledgeChunk; codes: string[]; onChanged: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<ChunkDraft>({ title: chunk.title, body: chunk.body, purpose: chunk.purpose, issue_codes: chunk.issue_codes, reason: '' })
  const [preview, setPreview] = useState<string | null>(null)
  const review = useMutation({
    mutationFn: (body: Parameters<typeof bpmApi.reviewKnowledge>[2]) => bpmApi.reviewKnowledge(kbId, chunk.id, body),
    onSuccess: () => { setEditing(false); onChanged() },
  })
  const showPreview = useMutation({
    mutationFn: () => bpmApi.previewKnowledge(kbId, chunk.id),
    onSuccess: res => setPreview(res.data.text),
  })
  const accepted = chunk.status === 'accepted' || chunk.status === 'edited'
  const error = review.isError ? apiErrorMessage(review.error, 'Could not save this passage.') : ''

  if (editing) {
    return <li className="border border-brand-500/40 rounded-xl p-3 space-y-2">
      <ChunkFields draft={draft} setDraft={setDraft} codes={codes} />
      {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
      <div className="flex justify-end gap-2">
        <button onClick={() => setEditing(false)} className="px-3 py-1 text-xs border border-surface-border rounded-lg">Cancel</button>
        <button onClick={() => review.mutate({ status: 'edited', edit_reason: draft.reason.trim(), title: draft.title,
          body: draft.body, purpose: draft.purpose, issue_codes: draft.issue_codes })}
          disabled={review.isPending || !draft.title.trim() || !draft.body.trim() || draft.reason.trim().length < MIN_REASON}
          className="flex items-center gap-1 px-3 py-1 text-xs bg-brand-600 text-white rounded-lg disabled:opacity-40">
          <Save className="w-3 h-3" /> Save passage
        </button>
      </div>
    </li>
  }

  return <li className={cn('border rounded-xl p-3', chunk.status === 'rejected' ? 'opacity-60 border-surface-border'
    : accepted ? 'border-green-200 dark:border-green-700/50 bg-green-50/40 dark:bg-green-900/10' : 'border-surface-border bg-surface-card')}>
    <div className="flex items-start gap-2">
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium">{chunk.title}</span>
          <span className="text-xs font-mono text-foreground/70">{chunk.chunk_key}</span>
          <span className="text-xs px-1.5 py-0.5 rounded-full bg-surface border border-surface-border">{PURPOSE_LABEL[chunk.purpose]}</span>
          <span className="text-xs text-foreground/70">{chunk.origin === 'human' ? 'Added by a reviewer' : 'From the AI'}</span>
          <span className="text-xs text-foreground/70">· {chunk.status === 'pending' ? 'Pending review' : chunk.status === 'rejected' ? 'Removed' : 'Accepted'}</span>
        </div>
        <p className="text-sm mt-1 whitespace-pre-wrap">{chunk.body}</p>
        <p className="text-xs text-foreground/70 mt-1">Applies to: {chunk.issue_codes.length ? chunk.issue_codes.join(', ') : 'every problem'}</p>
        {chunk.undefined_variables.length > 0 && <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">
          Needs a value: {chunk.undefined_variables.map(v => `{{${v}}}`).join(', ')}
        </p>}
        <SourceQuote excerpt={chunk.source_excerpt} verified={chunk.origin === 'ai' ? chunk.source_start != null : null} />
        {preview != null && <p className="mt-2 text-xs rounded-lg bg-surface border border-surface-border p-2 whitespace-pre-wrap" aria-label="Preview with sample values">{preview}</p>}
        {error && <p role="alert" className="text-xs text-red-600 mt-1">{error}</p>}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-1 shrink-0">
        <button onClick={() => showPreview.mutate()} title="Preview with sample values" aria-label="Preview with sample values"
          className="p-1.5 rounded-lg text-foreground/70 hover:text-brand-500"><Eye className="w-3.5 h-3.5" /></button>
        {!accepted && <button onClick={() => review.mutate({ status: 'accepted' })} disabled={review.isPending}
          title="Accept passage" aria-label="Accept passage" className="p-1.5 rounded-lg text-foreground/70 hover:text-green-600">
          <Check className="w-3.5 h-3.5" /></button>}
        {chunk.status !== 'rejected' && <button onClick={() => setEditing(true)} title="Edit passage" aria-label="Edit passage"
          className="p-1.5 rounded-lg text-foreground/70 hover:text-brand-500"><Pencil className="w-3.5 h-3.5" /></button>}
        {chunk.status !== 'rejected' && <ReasonAction label="Remove" title="Remove passage" icon={<Trash2 className="w-3.5 h-3.5" />}
          pending={review.isPending} onConfirm={reason => review.mutate({ status: 'rejected', edit_reason: reason })} />}
      </div>
    </div>
  </li>
}

function AddChunk({ kbId, entityId, codes, onAdded }: { kbId: string; entityId: string; codes: string[]; onAdded: () => void }) {
  const blank: ChunkDraft = { title: '', body: '', purpose: 'both', issue_codes: [], reason: '' }
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<ChunkDraft>(blank)
  const add = useMutation({
    mutationFn: () => bpmApi.addKnowledge(kbId, { entity_id: entityId, title: draft.title, body: draft.body,
      purpose: draft.purpose, issue_codes: draft.issue_codes, edit_reason: draft.reason.trim() || undefined }),
    onSuccess: () => { setOpen(false); setDraft(blank); onAdded() },
  })
  if (!open) return <button onClick={() => setOpen(true)}
    className="w-full flex items-center justify-center gap-2 py-3 border-2 border-dashed border-surface-border rounded-xl text-sm text-foreground/70 hover:border-brand-400">
    <Plus className="w-4 h-4" /> Add a passage the AI missed
  </button>
  return <div className="border border-brand-500/40 rounded-xl p-3 space-y-2">
    <ChunkFields draft={draft} setDraft={setDraft} codes={codes} />
    {add.isError && <p role="alert" className="text-xs text-red-600">{apiErrorMessage(add.error, 'Could not add the passage.')}</p>}
    <div className="flex justify-end gap-2">
      <button onClick={() => { setOpen(false); setDraft(blank) }} className="px-3 py-1 text-xs border border-surface-border rounded-lg">Cancel</button>
      <button onClick={() => add.mutate()} disabled={add.isPending || !draft.title.trim() || !draft.body.trim()}
        className="px-3 py-1 text-xs bg-brand-600 text-white rounded-lg disabled:opacity-40">Add passage</button>
    </div>
  </div>
}

function VariablesPanel({ kbId, businessLine, needed, suggestions, onChanged }: {
  kbId: string; businessLine: string | null; needed: string[]
  suggestions: Record<string, string>; onChanged: () => void
}) {
  const qc = useQueryClient()
  const key = ['bpm', 'variables', kbId]
  const vars = useQuery({ queryKey: key, queryFn: () => bpmApi.listVariables(kbId).then(r => r.data) })
  const [values, setValues] = useState<Record<string, string>>({})
  const [lineOnly, setLineOnly] = useState<Record<string, boolean>>({})
  const save = useMutation({
    mutationFn: (name: string) => bpmApi.setVariable(kbId, {
      name, value: (values[name] ?? suggestions[name] ?? '').trim(),
      business_line: lineOnly[name] ? businessLine : null,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: key }); onChanged() },
  })
  const defined = vars.data?.variables ?? []
  const describe = (name: string) => vars.data?.suggested.find(s => s.name === name)?.description
  return <section aria-label="Variables" className="rounded-xl border border-surface-border p-4 space-y-3 text-sm">
    <div>
      <h3 className="font-semibold">Variables</h3>
      <p className="text-xs text-foreground/70 mt-1">
        Passages embed these as {'{{name}}'}. Tenant values are set here; ticket values
        ({(vars.data?.ticket_variables ?? []).map(v => `{{${v.name}}}`).join(', ')}) are filled in for each ticket.
        A saved value is used by live replies straight away.
      </p>
    </div>
    {needed.length > 0 && <ul className="space-y-2">
      {needed.map(name => <li key={name} className="grid sm:grid-cols-[10rem_1fr_auto_auto] gap-2 items-end">
        <span className="font-mono text-xs">{`{{${name}}}`}<span className="block font-sans text-foreground/70">{describe(name) ?? 'Needs a value'}</span></span>
        <label className="text-xs text-foreground/70">Value
          <input className={inp + ' mt-0.5'} aria-label={`Value for ${name}`} maxLength={2000}
            value={values[name] ?? suggestions[name] ?? ''} onChange={e => setValues({ ...values, [name]: e.target.value })} />
          {suggestions[name] && values[name] == null && <span className="block">Found in the SOP</span>}
        </label>
        {businessLine ? <label className="flex items-center gap-1 text-xs">
          <input type="checkbox" checked={!!lineOnly[name]} onChange={e => setLineOnly({ ...lineOnly, [name]: e.target.checked })} />
          Only {businessLine}
        </label> : <span />}
        <button onClick={() => save.mutate(name)} disabled={!(values[name] ?? suggestions[name] ?? '').trim() || save.isPending}
          className="px-3 py-1.5 text-xs bg-brand-600 text-white rounded-lg disabled:opacity-40">Save</button>
      </li>)}
    </ul>}
    {save.isError && <p role="alert" className="text-xs text-red-600">{apiErrorMessage(save.error, 'Could not save the variable.')}</p>}
    {defined.length > 0 && <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
      {defined.map(v => <div key={v.id} className="contents">
        <dt className="font-mono">{`{{${v.name}}}`}{v.business_line ? ` · ${v.business_line}` : ''}</dt>
        <dd className="text-foreground/70 break-words">{v.value}</dd>
      </div>)}
    </dl>}
  </section>
}

export function KnowledgeStep({ kbId, entityId, onNext, onBack }: {
  kbId: string; entityId: string; onNext: () => void; onBack: () => void
}) {
  const qc = useQueryClient()
  const key = ['bpm', 'knowledge', kbId, entityId]
  const listing = useQuery({ queryKey: key, queryFn: () => bpmApi.listKnowledge(kbId, entityId).then(r => r.data) })
  const accepted = useQuery({
    queryKey: ['taxonomy-proposals', kbId, entityId],
    queryFn: () => bpmApi.listTaxonomyProposals(kbId, entityId).then(r => r.data),
  })
  const [suggestions, setSuggestions] = useState<Record<string, string>>({})
  const refresh = () => qc.invalidateQueries({ queryKey: key })
  const extract = useMutation({
    mutationFn: () => bpmApi.extractKnowledge(kbId, entityId),
    onSuccess: res => {
      setSuggestions(Object.fromEntries((res.data.suggested_variables ?? []).map(v => [v.name, v.value])))
      refresh()
    },
  })
  const acceptAll = useMutation({ mutationFn: () => bpmApi.acceptAll(kbId, entityId, 'knowledge'), onSuccess: refresh })
  const chunks = listing.data?.chunks ?? []
  const codes = (accepted.data ?? []).filter(p => p.status === 'accepted' || p.status === 'edited').map(p => p.issue_code)
  const pending = chunks.filter(c => c.status === 'pending').length
  const needed = listing.data?.undefined_variables ?? []

  return <div className="space-y-4">
    <div>
      <h2 className="text-lg font-semibold">What should the AI and your agents know?</h2>
      <p className="text-sm text-foreground/70 mt-1">
        Passages from your SOP guide the AI's decision for a ticket's problem and supply the wording of replies your agents review.
        Check each against the quoted source, fix what is wrong, and add what is missing. They go live with this version.
      </p>
    </div>
    {listing.isLoading ? <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-brand-500" /></div>
      : listing.isError ? <p role="alert" className="text-sm text-red-600">{apiErrorMessage(listing.error, 'Passages could not be loaded.')}</p>
      : <>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-foreground/70">{chunks.length} passage{chunks.length === 1 ? '' : 's'} · {pending} pending</span>
          <div className="flex gap-2">
            <button onClick={() => { if (!chunks.some(c => c.origin === 'ai') || window.confirm('Read the SOP again? This replaces the AI passages below and your review of them; passages you added are kept.')) extract.mutate() }}
              disabled={extract.isPending}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-brand-600 text-white rounded-lg disabled:opacity-40">
              {extract.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
              {chunks.some(c => c.origin === 'ai') ? 'Extract again' : 'Extract passages'}
            </button>
            {pending > 0 && <button onClick={() => acceptAll.mutate()} disabled={acceptAll.isPending}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-green-300 text-green-700 rounded-lg">
              <Check className="w-3 h-3" /> Accept all ({pending})</button>}
          </div>
        </div>
        {extract.isError && <p role="alert" className="text-sm text-red-600">{apiErrorMessage(extract.error, 'Extraction failed.')}</p>}
        {acceptAll.isError && <p role="alert" className="text-sm text-red-600">{apiErrorMessage(acceptAll.error, 'Could not accept the passages.')}</p>}
        <ul className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
          {chunks.map(chunk => <ChunkCard key={chunk.id} kbId={kbId} chunk={chunk} codes={codes} onChanged={refresh} />)}
        </ul>
        <AddChunk kbId={kbId} entityId={entityId} codes={codes} onAdded={refresh} />
        <VariablesPanel kbId={kbId} businessLine={listing.data?.business_line ?? null} needed={needed}
          suggestions={suggestions} onChanged={refresh} />
      </>}
    <div className="flex justify-between pt-1">
      <button onClick={onBack} className="flex items-center gap-2 px-4 py-2 text-sm border border-surface-border rounded-lg"><ArrowLeft className="w-4 h-4" /> Back</button>
      <button onClick={onNext} disabled={pending > 0 || needed.length > 0}
        className="flex items-center gap-2 px-5 py-2.5 bg-brand-600 text-white rounded-lg text-sm font-medium disabled:opacity-40">
        Compare sample decisions <ArrowRight className="w-4 h-4" />
      </button>
    </div>
  </div>
}

