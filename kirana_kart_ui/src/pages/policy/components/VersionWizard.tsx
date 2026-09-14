/**
 * VersionWizard — 7-step guided flow for creating a new policy version.
 *
 * Step 1 — Upload Document
 * Step 2 — AI Analysis (extract taxonomy from SOP)
 * Step 3 — Taxonomy Review (accept / edit / reject each issue node)
 * Step 4 — Action Review (accept / edit / reject each extracted action)
 * Step 5 — Rules Review (deterministically generated rules, inline editing)
 * Step 6 — Preview (simple simulation)
 * Step 7 — Publish
 */

import { useState, useRef, useCallback, useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  X, Upload, FileText, FileType, CheckCircle2, Loader2,
  AlertTriangle, ArrowRight, ArrowLeft, Sparkles, BarChart2,
  CloudUpload, Pencil, Trash2, Plus, Save, Check, XCircle,
  ChevronRight, Tag, Zap,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { useAuthStore } from '@/stores/auth.store'
import { hasPermission } from '@/lib/access'
import { governanceClient as apiClient } from '@/api/clients'
import {
  bpmApi,
  type TaxonomyProposal,
  type ActionProposal,
  type ReviewProposalPayload,
} from '@/api/governance/bpm.api'

interface Props {
  kbId: string
  onClose: () => void
  onCreated: () => void
}

type Step = 1 | 2 | 3 | 4 | 5 | 6 | 7

// ============================================================
// API helpers
// ============================================================

interface BusinessBrief { name: string; outcome: string; scope: string }

const uploadDocument = (kbId: string, file: File, brief: BusinessBrief) => {
  const form = new FormData()
  form.append('file', file)
  form.append('change_name', brief.name)
  form.append('business_outcome', brief.outcome)
  form.append('affected_scope', brief.scope)
  return apiClient.post<{ upload_id: string; filename: string; entity_id: string; bpm_instance_id: number }>(
    `/bpm/kb/${kbId}/upload`, form,
    { headers: { 'Content-Type': 'multipart/form-data' } },
  )
}

const fetchRules = (kbId: string, version: string) =>
  apiClient.get<Array<{
    id: number
    rule_id: string
    issue_type_l1: string
    issue_type_l2: string | null
    action_name: string
    priority: number
    conditions: Record<string, unknown>
    min_order_value: number | null
    max_order_value: number | null
    deterministic: boolean
  }>>(`/rules/${kbId}`, { params: { version } })

const publishVersion = (kbId: string, entityId: string) =>
  apiClient.post(`/bpm/kb/${kbId}/publish`, { entity_id: entityId })

// ============================================================
// Step indicator
// ============================================================

const PHASES = ['Define change', 'Review decisions', 'Test impact', 'Launch decision']
function StepIndicator({ current }: { current: Step }) {
  const phase = current === 1 ? 0 : current <= 5 ? 1 : current === 6 ? 2 : 3
  return <ol aria-label="Policy change journey" className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-6">
    {PHASES.map((label, index) => <li key={label} aria-current={index === phase ? 'step' : undefined}
      className={cn('rounded-lg border px-3 py-2 text-xs', index === phase ? 'border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-400' : 'border-surface-border text-foreground/70')}>
      <span className="block text-[10px] uppercase tracking-wider mb-1">{index + 1} / {PHASES.length}</span>{label}
    </li>)}
  </ol>
}

// ============================================================
// Shared input style
// ============================================================

const inp = 'w-full px-2.5 py-1.5 rounded-lg border border-surface-border bg-surface text-sm text-foreground placeholder:text-foreground/70 focus:outline-none focus:ring-1 focus:ring-brand-500'

// ============================================================
// Step 1 — Upload
// ============================================================

const ACCEPTED = '.pdf,.docx,.md,.txt,.csv'

function UploadStep({
  kbId,
  onNext,
}: {
  kbId: string
  onNext: (entityId: string, filename: string) => void
}) {
  const [brief, setBrief] = useState<BusinessBrief>({ name: '', outcome: '', scope: '' })
  const [dragOver, setDragOver] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const uploadMutation = useMutation({
    mutationFn: (f: File) => uploadDocument(kbId, f, brief),
    onSuccess: (res) => onNext(res.data.entity_id, res.data.filename),
    onError: (e: Error) => setError(e.message ?? 'Upload failed. Please try again.'),
  })

  const handleFile = useCallback((f: File) => { setError(''); setFile(f) }, [])
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false)
    const f = e.dataTransfer.files[0]; if (f) handleFile(f)
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">What would you like to improve?</h2>
        <p className="text-sm text-foreground/70 mt-1">
          Turn your operating policy into a proposal your team can review and test before it changes customer decisions.
        </p>
      </div>

      <div className="space-y-4">
        <label className="block text-sm font-medium">Name this change
          <input className={inp + ' mt-1'} maxLength={160} value={brief.name} onChange={e => setBrief({ ...brief, name: e.target.value })} placeholder="e.g. Faster resolution for missing items" />
        </label>
        <label className="block text-sm font-medium">What business outcome are you aiming for?
          <textarea className={inp + ' mt-1'} maxLength={2000} rows={2} value={brief.outcome} onChange={e => setBrief({ ...brief, outcome: e.target.value })} placeholder="e.g. Reduce manual reviews while keeping compensation within our approved budget" />
        </label>
        <label className="block text-sm font-medium">Who or what should this affect? <span className="text-foreground/70 font-normal">(optional)</span>
          <input className={inp + ' mt-1'} maxLength={1000} value={brief.scope} onChange={e => setBrief({ ...brief, scope: e.target.value })} placeholder="e.g. Missing-item complaints in grocery delivery" />
        </label>
        <p className="text-xs text-foreground/70">Your brief is saved with the uploaded proposal. Scope describes your intent; confirm the generated conditions actually enforce it.</p>
      </div>
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        className={cn(
          'border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-colors',
          dragOver
            ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/20'
            : 'border-surface-border hover:border-brand-400 hover:bg-surface/50',
        )}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED}
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f) }}
        />
        {file ? (
          <div className="flex flex-col items-center gap-2">
            <FileText className="w-10 h-10 text-brand-500" />
            <p className="text-sm font-medium text-foreground">{file.name}</p>
            <p className="text-xs text-foreground/70">{(file.size / 1024).toFixed(1)} KB</p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <CloudUpload className="w-10 h-10 text-foreground/70" />
            <div>
              <p className="text-sm font-medium text-foreground">Drag & drop your SOP document here</p>
              <p className="text-xs text-foreground/70 mt-1">or click to browse files</p>
            </div>
            <p className="text-xs text-subtle">PDF · Word · Markdown · CSV</p>
          </div>
        )}
      </div>

      {file?.name.endsWith('.csv') && (
        <div className="flex items-start gap-2 bg-blue-50 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-700 rounded-lg p-3 text-sm text-blue-700 dark:text-blue-300">
          <FileType className="w-4 h-4 shrink-0 mt-0.5" />
          <span>CSV selected. Review the interpretation and generated decisions before using them.</span>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 dark:bg-red-900/10 border border-red-200 rounded-lg p-3">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      <div className="flex justify-between items-center">
        <p className="text-xs text-foreground/70">Maximum file size: 20 MB</p>
        <button
          disabled={!file || !brief.name.trim() || !brief.outcome.trim() || uploadMutation.isPending}
          onClick={() => file && uploadMutation.mutate(file)}
          className="flex items-center gap-2 px-5 py-2.5 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-40 transition-colors"
        >
          {uploadMutation.isPending ? (
            <><Loader2 className="w-4 h-4 animate-spin" /> Uploading...</>
          ) : (
            <><Upload className="w-4 h-4" /> Create proposal</>
          )}
        </button>
      </div>
    </div>
  )
}

// ============================================================
// Step 2 — AI Analysis (extract taxonomy)
// ============================================================

type AnalysisStatus = 'idle' | 'running' | 'done' | 'error'

function AIAnalysisStep({
  kbId,
  entityId,
  filename,
  onNext,
  onBack,
}: {
  kbId: string
  entityId: string
  filename: string
  onNext: (count: number) => void
  onBack: () => void
}) {
  const [status, setStatus] = useState<AnalysisStatus>('idle')
  const [findings, setFindings] = useState<string[]>([])
  const [error, setError] = useState('')

  const extractMut = useMutation({
    mutationFn: () => bpmApi.extractTaxonomy(kbId, entityId),
    onMutate: () => { setStatus('running'); setFindings([]) },
    onSuccess: (res) => {
      setStatus('done')
      const proposals: TaxonomyProposal[] = (res.data as { proposals?: TaxonomyProposal[] }).proposals ?? []
      const newCount = proposals.filter((p) => p.proposal_type === 'new').length
      const existingCount = proposals.filter((p) => p.proposal_type === 'existing').length
      setFindings([
        `${proposals.length} issue categories identified`,
        newCount > 0 ? `${newCount} new categories to review` : 'All categories already in registry',
        existingCount > 0 ? `${existingCount} matched to existing taxonomy` : '',
        'Ready for your review',
      ].filter(Boolean))
      onNext(proposals.length)
    },
    onError: (e: Error) => {
      setStatus('error'); setError(e.message ?? 'Analysis failed. Please try again.')
    },
  })

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Understand your SOP</h2>
        <p className="text-sm text-foreground/70 mt-1">
          We are identifying customer problems in your SOP and matching them to your existing categories. You remain in control of the interpretation.
        </p>
      </div>

      <div className="bg-surface-card border border-surface-border rounded-xl p-5">
        <div className="flex items-center gap-3 mb-4">
          <FileText className="w-5 h-5 text-foreground/70 shrink-0" />
          <span className="text-sm font-medium text-foreground truncate">{filename}</span>
        </div>

        {status === 'idle' && (
          <p className="text-sm text-foreground/70 text-center py-4">
            Identify the customer problems described in your SOP, then review the interpretation.
          </p>
        )}

        {(status === 'running' || status === 'done') && (
          <div className="space-y-3">
            <p role="status" className="flex items-center gap-2 text-sm text-foreground/70">{status === 'running' && <Loader2 className="w-4 h-4 animate-spin" />}{status === 'done' ? 'Interpretation ready for review' : 'Reading your document. Timing depends on its length and complexity.'}</p>
            {findings.length > 0 && (
              <div className="mt-4 space-y-1.5">
                {findings.map((f) => (
                  <div key={f} className="flex items-center gap-2 text-sm text-green-600">
                    <CheckCircle2 className="w-4 h-4 shrink-0" />
                    {f}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {status === 'error' && (
          <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 dark:bg-red-900/10 border border-red-200 rounded-lg p-3 mt-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            {error}
          </div>
        )}
      </div>

      <div className="flex justify-between">
        <button
          onClick={onBack}
          className="flex items-center gap-2 px-4 py-2 text-sm border border-surface-border rounded-lg text-foreground hover:bg-surface transition-colors"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </button>

        {status !== 'done' ? (
          <button
            onClick={() => extractMut.mutate()}
            disabled={status === 'running'}
            className="flex items-center gap-2 px-5 py-2.5 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-40 transition-colors"
          >
            {status === 'running' ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Reading customer problems...</>
            ) : (
              <><Sparkles className="w-4 h-4" /> {status === 'error' ? 'Retry' : 'Identify customer problems'}</>
            )}
          </button>
        ) : (
          <button
            onClick={() => onNext(0)}
            className="flex items-center gap-2 px-5 py-2.5 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 transition-colors"
          >
            Review customer problems <ArrowRight className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  )
}

// ============================================================
// Step 3 — Taxonomy Review
// ============================================================

type ProposalStatus = 'pending' | 'accepted' | 'rejected' | 'edited'

function statusBadge(status: ProposalStatus) {
  if (status === 'accepted' || status === 'edited')
    return <span className="text-xs px-1.5 py-0.5 rounded-full bg-green-100 dark:bg-green-900/30 text-green-600 font-medium">Accepted</span>
  if (status === 'rejected')
    return <span className="text-xs px-1.5 py-0.5 rounded-full bg-red-100 dark:bg-red-900/30 text-red-500 font-medium">Rejected</span>
  return <span className="text-xs px-1.5 py-0.5 rounded-full bg-yellow-100 dark:bg-yellow-900/30 text-yellow-600 font-medium">Pending</span>
}

function typeBadge(type: string) {
  if (type === 'new') return <span className="text-xs px-1.5 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-600">New</span>
  if (type === 'update') return <span className="text-xs px-1.5 py-0.5 rounded-full bg-orange-100 dark:bg-orange-900/30 text-orange-500">Update</span>
  return <span className="text-xs px-1.5 py-0.5 rounded-full bg-surface text-foreground/70 border border-surface-border">Existing</span>
}

function TaxonomyProposalRow({
  proposal,
  kbId,
  onUpdated,
}: {
  proposal: TaxonomyProposal
  kbId: string
  onUpdated: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [label, setLabel] = useState(proposal.label)
  const [description, setDescription] = useState(proposal.description ?? '')

  const reviewMut = useMutation({
    mutationFn: (payload: ReviewProposalPayload) =>
      bpmApi.reviewTaxonomyProposal(kbId, proposal.id, payload),
    onSuccess: () => { setEditing(false); onUpdated() },
  })

  const accept = () => reviewMut.mutate({ status: 'accepted' })
  const reject = () => reviewMut.mutate({ status: 'rejected' })
  const saveEdit = () => reviewMut.mutate({
    status: 'edited',
    edit_reason: 'User correction',
    user_output: { label, description },
  })

  const indent = proposal.level * 20

  return (
    <div
      className={cn(
        'border rounded-xl p-3 transition-colors',
        proposal.status === 'rejected'
          ? 'border-surface-border bg-surface opacity-60'
          : proposal.status === 'accepted' || proposal.status === 'edited'
            ? 'border-green-200 dark:border-green-700/50 bg-green-50/40 dark:bg-green-900/10'
            : 'border-surface-border bg-surface-card',
      )}
      style={{ marginLeft: indent }}
    >
      {editing ? (
        <div className="space-y-2">
          <div>
            <label className="text-xs text-foreground/70 mb-0.5 block">Label</label>
            <input className={inp} value={label} onChange={e => setLabel(e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-foreground/70 mb-0.5 block">Description</label>
            <input className={inp} value={description} onChange={e => setDescription(e.target.value)} placeholder="Optional description" />
          </div>
          <div className="flex gap-2 justify-end">
            <button onClick={() => setEditing(false)} className="px-3 py-1 text-xs border border-surface-border rounded-lg text-foreground hover:bg-surface">Cancel</button>
            <button
              onClick={saveEdit}
              disabled={reviewMut.isPending || !label}
              className="flex items-center gap-1 px-3 py-1 text-xs bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-40"
            >
              <Save className="w-3 h-3" /> {reviewMut.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          {proposal.level > 0 && <ChevronRight className="w-3 h-3 text-foreground/70 shrink-0" />}
          <Tag className="w-3.5 h-3.5 text-foreground/70 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-sm font-medium text-foreground">{proposal.label}</span>
              <span className="text-xs font-mono text-foreground/70">{proposal.issue_code}</span>
              {typeBadge(proposal.proposal_type)}
              {statusBadge(proposal.status)}
              {proposal.extraction_confidence != null && (
                <span className="text-xs text-foreground/70">
                  AI interpretation: {Math.round(proposal.extraction_confidence * 100)}% confidence — verify against your SOP
                </span>
              )}
            </div>
            {proposal.description && (
              <p className="text-xs text-foreground/70 mt-0.5 truncate">{proposal.description}</p>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {proposal.status !== 'rejected' && proposal.status !== 'accepted' && proposal.status !== 'edited' && (
              <button
                onClick={accept}
                disabled={reviewMut.isPending}
                className="p-1.5 rounded-lg text-foreground/70 hover:text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 transition-colors"
                title="Accept"
              >
                <Check className="w-3.5 h-3.5" />
              </button>
            )}
            {(proposal.status === 'accepted' || proposal.status === 'edited') && (
              <button
                onClick={reject}
                disabled={reviewMut.isPending}
                className="p-1.5 rounded-lg text-foreground/70 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/10 transition-colors"
                title="Reject"
              >
                <XCircle className="w-3.5 h-3.5" />
              </button>
            )}
            {proposal.status === 'rejected' && (
              <button
                onClick={accept}
                disabled={reviewMut.isPending}
                className="p-1.5 rounded-lg text-foreground/70 hover:text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 transition-colors"
                title="Restore"
              >
                <Check className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              onClick={() => setEditing(true)}
              className="p-1.5 rounded-lg text-foreground/70 hover:text-brand-500 hover:bg-surface transition-colors"
              title="Edit"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function TaxonomyReviewStep({
  kbId,
  entityId,
  onNext,
  onBack,
}: {
  kbId: string
  entityId: string
  onNext: () => void
  onBack: () => void
}) {
  const qc = useQueryClient()
  const qKey = ['taxonomy-proposals', kbId, entityId]
  const { data: proposals = [], isLoading } = useQuery({
    queryKey: qKey,
    queryFn: () => bpmApi.listTaxonomyProposals(kbId, entityId).then(r => r.data),
  })

  const refresh = () => qc.invalidateQueries({ queryKey: qKey })

  const sorted = [...proposals].sort((a, b) => a.level - b.level || a.issue_code.localeCompare(b.issue_code))
  const accepted = proposals.filter((p: TaxonomyProposal) => p.status === 'accepted' || p.status === 'edited').length
  const pending = proposals.filter((p: TaxonomyProposal) => p.status === 'pending').length

  const acceptAll = useMutation({
    mutationFn: async () => {
      const pendingProposals = (proposals as TaxonomyProposal[]).filter(p => p.status === 'pending')
      for (const p of pendingProposals) {
        await bpmApi.reviewTaxonomyProposal(kbId, p.id, { status: 'accepted' })
      }
    },
    onSuccess: refresh,
  })

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Which customer problems does this cover?</h2>
          <p className="text-sm text-foreground/70 mt-1">
            These customer problems were identified in your document. Keep the right ones, clarify their meaning, or exclude them.
            Each accepted problem will link to a response and the conditions for using it.
          </p>
        </div>
        {pending > 0 && (
          <button
            onClick={() => acceptAll.mutate()}
            disabled={acceptAll.isPending}
            className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-xs bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 border border-green-200 dark:border-green-700 rounded-lg hover:bg-green-100 dark:hover:bg-green-900/30 transition-colors disabled:opacity-40"
          >
            <Check className="w-3 h-3" /> Accept all ({pending})
          </button>
        )}
      </div>

      {proposals.length > 0 && (
        <div className="flex items-center gap-3 text-xs text-foreground/70">
          <span className="text-green-600 font-medium">{accepted} accepted</span>
          <span>·</span>
          <span>{pending} pending</span>
          <span>·</span>
          <span>{proposals.filter((p: TaxonomyProposal) => p.status === 'rejected').length} rejected</span>
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="w-6 h-6 animate-spin text-brand-500" />
        </div>
      ) : sorted.length === 0 ? (
        <div className="text-center py-8 text-sm text-foreground/70">
          No proposals found. Go back and run AI analysis first.
        </div>
      ) : (
        <div className="space-y-1.5 max-h-[400px] overflow-y-auto pr-1">
          {sorted.map((p: TaxonomyProposal) => (
            <TaxonomyProposalRow
              key={p.id}
              proposal={p}
              kbId={kbId}
              onUpdated={refresh}
            />
          ))}
        </div>
      )}

      <div className="flex justify-between pt-1">
        <button
          onClick={onBack}
          className="flex items-center gap-2 px-4 py-2 text-sm border border-surface-border rounded-lg text-foreground hover:bg-surface transition-colors"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <button
          onClick={onNext}
          disabled={accepted === 0 || pending > 0}
          className="flex items-center gap-2 px-5 py-2.5 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-40 transition-colors"
        >
          Identify responses <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}

// ============================================================
// Step 4 — Action Review
// ============================================================

function ActionProposalCard({
  action,
  kbId,
  onUpdated,
}: {
  action: ActionProposal
  kbId: string
  onUpdated: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [actionName, setActionName] = useState(action.action_name)
  const [exactAction, setExactAction] = useState(action.exact_action ?? '')
  const [description, setDescription] = useState(action.action_description ?? '')

  const reviewMut = useMutation({
    mutationFn: (payload: ReviewProposalPayload) =>
      bpmApi.reviewActionProposal(kbId, action.id, payload),
    onSuccess: () => { setEditing(false); onUpdated() },
  })

  const accept = () => reviewMut.mutate({ status: 'accepted' })
  const reject = () => reviewMut.mutate({ status: 'rejected' })
  const saveEdit = () => reviewMut.mutate({
    status: 'edited',
    edit_reason: 'User correction',
    user_output: { action_name: actionName, exact_action: exactAction, action_description: description },
  })

  const flags = [
    action.requires_refund && 'Refund',
    action.requires_escalation && 'Escalation',
    action.automation_eligible && 'Automatable',
  ].filter(Boolean) as string[]

  return (
    <div className={cn(
      'border rounded-xl p-4 transition-colors',
      action.status === 'rejected'
        ? 'border-surface-border bg-surface opacity-60'
        : action.status === 'accepted' || action.status === 'edited'
          ? 'border-green-200 dark:border-green-700/50 bg-green-50/40 dark:bg-green-900/10'
          : 'border-surface-border bg-surface-card',
    )}>
      {editing ? (
        <div className="space-y-2">
          <div>
            <label className="text-xs text-foreground/70 mb-0.5 block">Action name *</label>
            <input className={inp} value={actionName} onChange={e => setActionName(e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-foreground/70 mb-0.5 block">Exact action (what the agent should do)</label>
            <textarea
              className={cn(inp, 'min-h-[60px] resize-y')}
              value={exactAction}
              onChange={e => setExactAction(e.target.value)}
              placeholder="e.g. Issue full refund of order amount + ₹100 goodwill credit"
            />
          </div>
          <div>
            <label className="text-xs text-foreground/70 mb-0.5 block">Description</label>
            <input className={inp} value={description} onChange={e => setDescription(e.target.value)} />
          </div>
          <div className="flex gap-2 justify-end">
            <button onClick={() => setEditing(false)} className="px-3 py-1.5 text-xs border border-surface-border rounded-lg text-foreground hover:bg-surface">Cancel</button>
            <button
              onClick={saveEdit}
              disabled={reviewMut.isPending || !actionName}
              className="flex items-center gap-1 px-3 py-1.5 text-xs bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-40"
            >
              <Save className="w-3 h-3" /> {reviewMut.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-2">
          <Zap className="w-4 h-4 text-foreground/70 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-sm font-medium text-foreground">{action.action_name}</span>
              <span className="text-xs font-mono text-foreground/70">{action.action_code_id}</span>
              {typeBadge(action.proposal_type)}
              {statusBadge(action.status)}
            </div>
            {action.exact_action && (
              <p className="text-xs text-foreground/70 mt-1">{action.exact_action}</p>
            )}
            {action.parent_issue_codes.length > 0 && (
              <div className="flex items-center gap-1 flex-wrap mt-1">
                <span className="text-xs text-foreground/70">Applies to:</span>
                {action.parent_issue_codes.slice(0, 3).map(c => (
                  <span key={c} className="text-xs px-1.5 py-0.5 bg-surface border border-surface-border rounded text-foreground/70">{c}</span>
                ))}
                {action.parent_issue_codes.length > 3 && (
                  <span className="text-xs text-foreground/70">+{action.parent_issue_codes.length - 3} more</span>
                )}
              </div>
            )}
            {flags.length > 0 && (
              <div className="flex gap-1 mt-1.5">
                {flags.map(f => (
                  <span key={f} className="text-xs px-1.5 py-0.5 bg-amber-50 dark:bg-amber-900/20 text-amber-600 border border-amber-200 dark:border-amber-700 rounded">{f}</span>
                ))}
              </div>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {action.status === 'pending' && (
              <button onClick={accept} disabled={reviewMut.isPending}
                className="p-1.5 rounded-lg text-foreground/70 hover:text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 transition-colors" title="Accept">
                <Check className="w-3.5 h-3.5" />
              </button>
            )}
            {(action.status === 'accepted' || action.status === 'edited') && (
              <button onClick={reject} disabled={reviewMut.isPending}
                className="p-1.5 rounded-lg text-foreground/70 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/10 transition-colors" title="Reject">
                <XCircle className="w-3.5 h-3.5" />
              </button>
            )}
            {action.status === 'rejected' && (
              <button onClick={accept} disabled={reviewMut.isPending}
                className="p-1.5 rounded-lg text-foreground/70 hover:text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 transition-colors" title="Restore">
                <Check className="w-3.5 h-3.5" />
              </button>
            )}
            <button onClick={() => setEditing(true)}
              className="p-1.5 rounded-lg text-foreground/70 hover:text-brand-500 hover:bg-surface transition-colors" title="Edit">
              <Pencil className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

type ActionExtractStatus = 'idle' | 'running' | 'done' | 'error'

function ActionReviewStep({
  kbId,
  entityId,
  onNext,
  onBack,
}: {
  kbId: string
  entityId: string
  onNext: () => void
  onBack: () => void
}) {
  const qc = useQueryClient()
  const qKey = ['action-proposals', kbId, entityId]
  const [extractStatus, setExtractStatus] = useState<ActionExtractStatus>('idle')
  const [extractError, setExtractError] = useState('')

  const { data: actions = [], isLoading } = useQuery({
    queryKey: qKey,
    queryFn: () => bpmApi.listActionProposals(kbId, entityId).then(r => r.data),
    enabled: extractStatus === 'done',
  })

  const refresh = () => qc.invalidateQueries({ queryKey: qKey })

  const extractMut = useMutation({
    mutationFn: () => bpmApi.extractActions(kbId, entityId),
    onMutate: () => { setExtractStatus('running'); setExtractError('') },
    onSuccess: () => { setExtractStatus('done'); refresh() },
    onError: (e: Error) => { setExtractStatus('error'); setExtractError(e.message ?? 'Extraction failed.') },
  })

  const acceptAll = useMutation({
    mutationFn: async () => {
      const pendingActions = (actions as ActionProposal[]).filter(a => a.status === 'pending')
      for (const a of pendingActions) {
        await bpmApi.reviewActionProposal(kbId, a.id, { status: 'accepted' })
      }
    },
    onSuccess: refresh,
  })

  const accepted = (actions as ActionProposal[]).filter(a => a.status === 'accepted' || a.status === 'edited').length
  const pending = (actions as ActionProposal[]).filter(a => a.status === 'pending').length

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">What should your team do?</h2>
        <p className="text-sm text-foreground/70 mt-1">
          Review the responses your team can use: refund, replacement, escalation, or another action. Check eligibility and safeguards before accepting each response.
        </p>
      </div>

      {extractStatus === 'idle' && (
        <div className="bg-surface-card border border-surface-border rounded-xl p-5 text-center space-y-3">
          <Zap className="w-8 h-8 text-foreground/70 mx-auto" />
          <p className="text-sm text-foreground/70">Find the responses authorized for the customer problems you accepted.</p>
          <button
            onClick={() => extractMut.mutate()}
            className="flex items-center gap-2 px-5 py-2.5 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 mx-auto transition-colors"
          >
            <Sparkles className="w-4 h-4" /> Identify responses
          </button>
        </div>
      )}

      {extractStatus === 'running' && (
        <div className="bg-surface-card border border-surface-border rounded-xl p-5 text-center space-y-3">
          <Loader2 className="w-8 h-8 text-brand-500 mx-auto animate-spin" />
          <p className="text-sm text-foreground/70">Finding responses and exceptions in your SOP...</p>
        </div>
      )}

      {extractStatus === 'error' && (
        <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 dark:bg-red-900/10 border border-red-200 rounded-lg p-3">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {extractError}
          <button onClick={() => extractMut.mutate()} className="ml-auto underline text-red-600 text-xs">Retry</button>
        </div>
      )}

      {extractStatus === 'done' && (
        <>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 text-xs text-foreground/70">
              <span className="text-green-600 font-medium">{accepted} accepted</span>
              <span>·</span>
              <span>{pending} pending</span>
            </div>
            {pending > 0 && (
              <button
                onClick={() => acceptAll.mutate()}
                disabled={acceptAll.isPending}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 border border-green-200 dark:border-green-700 rounded-lg hover:bg-green-100 dark:hover:bg-green-900/30 transition-colors disabled:opacity-40"
              >
                <Check className="w-3 h-3" /> Accept all ({pending})
              </button>
            )}
          </div>

          {isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-brand-500" />
            </div>
          ) : (
            <div className="space-y-2 max-h-[380px] overflow-y-auto pr-1">
              {(actions as ActionProposal[]).map(a => (
                <ActionProposalCard
                  key={a.id}
                  action={a}
                  kbId={kbId}
                  onUpdated={refresh}
                />
              ))}
            </div>
          )}
        </>
      )}

      <div className="flex justify-between pt-1">
        <button
          onClick={onBack}
          className="flex items-center gap-2 px-4 py-2 text-sm border border-surface-border rounded-lg text-foreground hover:bg-surface transition-colors"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <button
          onClick={onNext}
          disabled={accepted === 0 || pending > 0}
          className="flex items-center gap-2 px-5 py-2.5 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-40 transition-colors"
        >
          Connect problems to responses <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}

// ============================================================
// Step 5 — Rules Review (inline editing)
// ============================================================

type Rule = {
  id: number
  rule_id: string
  issue_type_l1: string
  issue_type_l2: string | null
  action_name: string
  priority: number
  conditions: Record<string, unknown>
  min_order_value: number | null
  max_order_value: number | null
  deterministic: boolean
}

type EditDraft = {
  issue_type_l1: string
  issue_type_l2: string
  action_name: string
  priority: number
  min_order_value: string
  max_order_value: string
}

const BLANK_DRAFT: EditDraft = {
  issue_type_l1: '',
  issue_type_l2: '',
  action_name: '',
  priority: 50,
  min_order_value: '',
  max_order_value: '',
}

function RuleCard({
  rule,
  kbId,
  onSaved,
  onDeleted,
}: {
  rule: Rule
  kbId: string
  onSaved: () => void
  onDeleted: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<EditDraft>({
    issue_type_l1: rule.issue_type_l1,
    issue_type_l2: rule.issue_type_l2 ?? '',
    action_name: rule.action_name,
    priority: rule.priority,
    min_order_value: rule.min_order_value != null ? String(rule.min_order_value) : '',
    max_order_value: rule.max_order_value != null ? String(rule.max_order_value) : '',
  })
  const [saveErr, setSaveErr] = useState('')

  const saveMut = useMutation({
    mutationFn: () =>
      apiClient.put(`/rules/${kbId}/${rule.id}`, {
        issue_type_l1: draft.issue_type_l1,
        issue_type_l2: draft.issue_type_l2 || null,
        action_name: draft.action_name,
        priority: draft.priority,
        min_order_value: draft.min_order_value ? parseFloat(draft.min_order_value) : null,
        max_order_value: draft.max_order_value ? parseFloat(draft.max_order_value) : null,
      }),
    onSuccess: () => { setEditing(false); setSaveErr(''); onSaved() },
    onError: () => setSaveErr('Could not save. Please check the fields and try again.'),
  })

  const delMut = useMutation({
    mutationFn: () => apiClient.delete(`/rules/${kbId}/${rule.id}`),
    onSuccess: onDeleted,
  })

  if (editing) {
    return (
      <div className="bg-surface-card border border-brand-500/40 rounded-xl p-4 space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-xs text-foreground/70 mb-0.5 block">Customer problem *</label>
            <input className={inp} value={draft.issue_type_l1}
              onChange={e => setDraft(d => ({ ...d, issue_type_l1: e.target.value }))}
              placeholder="e.g. FOOD_SAFETY" />
          </div>
          <div>
            <label className="text-xs text-foreground/70 mb-0.5 block">More specific situation</label>
            <input className={inp} value={draft.issue_type_l2}
              onChange={e => setDraft(d => ({ ...d, issue_type_l2: e.target.value }))}
              placeholder="e.g. FOREIGN_OBJECT" />
          </div>
        </div>
        <div>
          <label className="text-xs text-foreground/70 mb-0.5 block">Action to take *</label>
          <input className={inp} value={draft.action_name}
            onChange={e => setDraft(d => ({ ...d, action_name: e.target.value }))}
            placeholder="e.g. Issue full refund + ₹100 compensation" />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="text-xs text-foreground/70 mb-0.5 block">Priority</label>
            <input className={inp} type="number" min={0} max={999} value={draft.priority}
              onChange={e => setDraft(d => ({ ...d, priority: (Number.isNaN(Number.parseInt(e.target.value, 10)) ? 50 : Number.parseInt(e.target.value, 10)) }))} />
          </div>
          <div>
            <label className="text-xs text-foreground/70 mb-0.5 block">Min order (₹)</label>
            <input className={inp} type="number" value={draft.min_order_value}
              onChange={e => setDraft(d => ({ ...d, min_order_value: e.target.value }))}
              placeholder="Any" />
          </div>
          <div>
            <label className="text-xs text-foreground/70 mb-0.5 block">Max order (₹)</label>
            <input className={inp} type="number" value={draft.max_order_value}
              onChange={e => setDraft(d => ({ ...d, max_order_value: e.target.value }))}
              placeholder="Any" />
          </div>
        </div>
        {saveErr && <p className="text-xs text-red-500">{saveErr}</p>}
        <div className="flex gap-2 justify-end">
          <button onClick={() => setEditing(false)}
            className="px-3 py-1.5 text-sm border border-surface-border rounded-lg text-foreground hover:bg-surface transition-colors">
            Cancel
          </button>
          <button
            onClick={() => saveMut.mutate()}
            disabled={saveMut.isPending || !draft.issue_type_l1 || !draft.action_name}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-40 transition-colors">
            <Save className="w-3.5 h-3.5" />
            {saveMut.isPending ? 'Saving…' : 'Save Rule'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="bg-surface-card border border-surface-border rounded-xl p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-mono text-foreground/70">{rule.rule_id}</span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-blue-50 dark:bg-blue-900/20 text-blue-600 font-medium">
              {rule.issue_type_l1}{rule.issue_type_l2 ? ` › ${rule.issue_type_l2}` : ''}
            </span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-surface text-foreground/70 border border-surface-border">
              Priority {rule.priority}
            </span>
            {rule.deterministic && (
              <span className="text-xs text-green-600 bg-green-50 dark:bg-green-900/20 px-2 py-0.5 rounded-full">Auto</span>
            )}
          </div>
          <p className="text-sm font-medium text-foreground mt-1.5">{rule.action_name}</p>
          {(rule.min_order_value != null || rule.max_order_value != null) && (
            <p className="text-xs text-foreground/70 mt-0.5">
              Order value:{' '}
              {rule.min_order_value != null ? `≥ ₹${rule.min_order_value}` : ''}
              {rule.min_order_value != null && rule.max_order_value != null ? ' · ' : ''}
              {rule.max_order_value != null ? `≤ ₹${rule.max_order_value}` : ''}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button onClick={() => setEditing(true)}
            className="p-1.5 rounded-lg text-foreground/70 hover:text-brand-500 hover:bg-surface transition-colors" title="Edit rule">
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => delMut.mutate()}
            disabled={delMut.isPending}
            className="p-1.5 rounded-lg text-foreground/70 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/10 transition-colors disabled:opacity-40"
            title="Remove rule">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}

function AddRuleCard({
  kbId,
  entityId,
  onAdded,
}: {
  kbId: string
  entityId: string
  onAdded: () => void
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<EditDraft>(BLANK_DRAFT)
  const [err, setErr] = useState('')

  const addMut = useMutation({
    mutationFn: () =>
      apiClient.post(`/rules/${kbId}`, {
        kb_id: kbId,
        version_label: entityId,
        issue_type_l1: draft.issue_type_l1,
        issue_type_l2: draft.issue_type_l2 || null,
        action_name: draft.action_name,
        priority: draft.priority,
        min_order_value: draft.min_order_value ? parseFloat(draft.min_order_value) : null,
        max_order_value: draft.max_order_value ? parseFloat(draft.max_order_value) : null,
      }),
    onSuccess: () => { setOpen(false); setDraft(BLANK_DRAFT); setErr(''); onAdded() },
    onError: () => setErr('Could not add rule. Please fill in all required fields.'),
  })

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full flex items-center justify-center gap-2 py-3 border-2 border-dashed border-surface-border rounded-xl text-sm text-foreground/70 hover:border-brand-400 hover:text-brand-500 transition-colors"
      >
        <Plus className="w-4 h-4" /> Add a rule manually
      </button>
    )
  }

  return (
    <div className="bg-surface-card border border-brand-500/40 rounded-xl p-4 space-y-3">
      <p className="text-sm font-semibold text-foreground">New Rule</p>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-xs text-foreground/70 mb-0.5 block">Customer problem *</label>
          <input className={inp} value={draft.issue_type_l1}
            onChange={e => setDraft(d => ({ ...d, issue_type_l1: e.target.value }))}
            placeholder="e.g. FOOD_SAFETY" />
        </div>
        <div>
          <label className="text-xs text-foreground/70 mb-0.5 block">More specific situation</label>
          <input className={inp} value={draft.issue_type_l2}
            onChange={e => setDraft(d => ({ ...d, issue_type_l2: e.target.value }))}
            placeholder="e.g. FOREIGN_OBJECT" />
        </div>
      </div>
      <div>
        <label className="text-xs text-foreground/70 mb-0.5 block">Action to take *</label>
        <input className={inp} value={draft.action_name}
          onChange={e => setDraft(d => ({ ...d, action_name: e.target.value }))}
          placeholder="e.g. Issue full refund + ₹100 compensation" />
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div>
          <label className="text-xs text-foreground/70 mb-0.5 block">Priority</label>
          <input className={inp} type="number" min={0} max={999} value={draft.priority}
            onChange={e => setDraft(d => ({ ...d, priority: (Number.isNaN(Number.parseInt(e.target.value, 10)) ? 50 : Number.parseInt(e.target.value, 10)) }))} />
        </div>
        <div>
          <label className="text-xs text-foreground/70 mb-0.5 block">Min order (₹)</label>
          <input className={inp} type="number" value={draft.min_order_value}
            onChange={e => setDraft(d => ({ ...d, min_order_value: e.target.value }))}
            placeholder="Any" />
        </div>
        <div>
          <label className="text-xs text-foreground/70 mb-0.5 block">Max order (₹)</label>
          <input className={inp} type="number" value={draft.max_order_value}
            onChange={e => setDraft(d => ({ ...d, max_order_value: e.target.value }))}
            placeholder="Any" />
        </div>
      </div>
      {err && <p className="text-xs text-red-500">{err}</p>}
      <div className="flex gap-2 justify-end">
        <button onClick={() => { setOpen(false); setDraft(BLANK_DRAFT); setErr('') }}
          className="px-3 py-1.5 text-sm border border-surface-border rounded-lg text-foreground hover:bg-surface transition-colors">
          Cancel
        </button>
        <button
          onClick={() => addMut.mutate()}
          disabled={addMut.isPending || !draft.issue_type_l1 || !draft.action_name}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-40 transition-colors">
          <Plus className="w-3.5 h-3.5" />
          {addMut.isPending ? 'Adding…' : 'Add Rule'}
        </button>
      </div>
    </div>
  )
}

type GenStatus = 'idle' | 'running' | 'done' | 'error'

function ReviewRulesStep({
  kbId,
  entityId,
  onNext,
  onBack,
}: {
  kbId: string
  entityId: string
  onNext: () => void
  onBack: () => void
}) {
  const qc = useQueryClient()
  const qKey = ['rules', kbId, entityId, 'wizard']
  const [genStatus, setGenStatus] = useState<GenStatus>('idle')
  const [genError, setGenError] = useState('')

  const { data: rules = [], isLoading } = useQuery({
    queryKey: qKey,
    queryFn: () => fetchRules(kbId, entityId).then(r => r.data),
    enabled: genStatus === 'done',
  })

  const refresh = () => qc.invalidateQueries({ queryKey: qKey })

  const generateMut = useMutation({
    mutationFn: () => bpmApi.generateRules(kbId, entityId),
    onMutate: () => { setGenStatus('running'); setGenError('') },
    onSuccess: () => { setGenStatus('done'); refresh() },
    onError: (e: Error) => { setGenStatus('error'); setGenError(e.message ?? 'Generation failed.') },
  })

  // Auto-generate on mount
  useEffect(() => {
    generateMut.mutate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Review the proposed decisions</h2>
        <p className="text-sm text-foreground/70 mt-1">
          Check the connection: when this customer problem occurs, under these conditions, take this action. Remove combinations that your SOP does not authorize.
        </p>
      </div>

      {genStatus === 'running' && (
        <div className="flex items-center justify-center gap-2 py-6 text-sm text-foreground/70">
          <Loader2 className="w-5 h-5 animate-spin text-brand-500" />
          Connecting customer problems to their proposed responses...
        </div>
      )}

      {genStatus === 'error' && (
        <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 dark:bg-red-900/10 border border-red-200 rounded-lg p-3">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {genError}
          <button onClick={() => generateMut.mutate()} className="ml-auto underline text-xs">Retry</button>
        </div>
      )}

      {genStatus === 'done' && (
        <>
          {isLoading ? (
            <div className="flex justify-center py-10">
              <Loader2 className="w-6 h-6 animate-spin text-brand-500" />
            </div>
          ) : rules.length === 0 ? (
            <div className="text-center py-6 text-sm text-foreground/70">
              No rules generated. Add rules manually below.
            </div>
          ) : (
            <div className="space-y-2 max-h-[380px] overflow-y-auto pr-1">
              {(rules as Rule[]).map((rule) => (
                <RuleCard
                  key={rule.id}
                  rule={rule}
                  kbId={kbId}
                  onSaved={refresh}
                  onDeleted={refresh}
                />
              ))}
            </div>
          )}
          {rules.length > 0 && (
            <p className="text-xs text-foreground/70 text-center">
              {rules.length} rule{rules.length !== 1 ? 's' : ''}
            </p>
          )}
        </>
      )}

      <AddRuleCard kbId={kbId} entityId={entityId} onAdded={refresh} />

      <div className="flex justify-between pt-1">
        <button
          onClick={onBack}
          className="flex items-center gap-2 px-4 py-2 text-sm border border-surface-border rounded-lg text-foreground hover:bg-surface transition-colors"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <button
          onClick={onNext}
          disabled={genStatus !== 'done' || (rules as Rule[]).length === 0}
          className="flex items-center gap-2 px-5 py-2.5 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-40 transition-colors"
        >
          Compare sample decisions <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}

// ============================================================
// Step 6 — Preview (simple)
// ============================================================

type SimStatus = 'idle' | 'running' | 'passed' | 'failed' | 'unavailable' | 'error'

interface SimResponse {
  status: 'ok' | 'unavailable'
  passed: boolean | null
  reason?: string
  metrics: {
    unchanged_rate: number
    changed_count: number
    ticket_count: number
    rule_count: number
    baseline_version: string
    candidate_version: string
    threshold: number
    sample_source?: string
    measurement_scope?: string
    examples?: Array<{ ticket_id: string | number; baseline: string; candidate: string }>
  } | null
}

function PreviewStep({
  kbId,
  entityId,
  onNext,
  onBack,
  onResult,
}: {
  kbId: string
  entityId: string
  onNext: () => void
  onBack: () => void
  onResult: (result: SimResponse | null) => void
}) {
  const [simStatus, setSimStatus] = useState<SimStatus>('idle')
  const [metrics, setMetrics] = useState<Record<string, string> | null>(null)
  const [notice, setNotice] = useState('')

  const runSimMutation = useMutation({
    mutationFn: () =>
      apiClient.post<SimResponse>(`/bpm/kb/${kbId}/simulate`, { entity_id: entityId }),
    onMutate: () => { onResult(null); setSimStatus('running'); setNotice(''); setMetrics(null) },
    onSuccess: (res) => {
      onResult(res.data)
      const { status, passed, reason, metrics: m } = res.data

      // The gate reports honestly when it cannot run. Previously this branch
      // fell back to a hardcoded 0.94, so the reviewer was shown a confident
      // "94.0% unchanged" for a simulation that never happened.
      if (status !== 'ok' || !m) {
        setSimStatus('unavailable')
        setNotice(reason || 'The preview could not be run for this version.')
        return
      }

      setSimStatus(passed ? 'passed' : 'failed')
      setMetrics({
        'Decisions unchanged': `${(m.unchanged_rate * 100).toFixed(1)}%`,
        'Decisions different': `${((1 - m.unchanged_rate) * 100).toFixed(1)}%`,
        'Tickets tested': String(m.ticket_count),
        'Decisions changed': String(m.changed_count),
        'Compared against': m.baseline_version,
      })
    },
    onError: () => {
      setSimStatus('error')
      setNotice('The comparison could not be completed. Try again or ask your support team for help.')
    },
  })

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">What would change?</h2>
        <p className="text-sm text-foreground/70 mt-1">
          Compare the current and proposed policies on saved sample cases. This replay does not change customer decisions.
        </p>
      </div>

      <div className={cn(
        'rounded-xl border p-5',
        simStatus === 'passed'
          ? 'border-green-200 dark:border-green-700 bg-green-50 dark:bg-green-900/10'
          : simStatus === 'failed'
            ? 'border-amber-200 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/10'
            : simStatus === 'unavailable' || simStatus === 'error'
              ? 'border-amber-200 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/10'
              : 'border-surface-border bg-surface-card',
      )}>
        <div className="flex items-center gap-3 mb-4">
          <BarChart2 className="w-5 h-5 text-foreground/70 shrink-0" />
          <p className="text-sm font-semibold text-foreground">Decision comparison</p>
          {simStatus === 'passed' && (
            <span className="ml-auto text-xs px-2 py-0.5 rounded-full bg-green-100 dark:bg-green-900/30 text-green-600 font-medium">Within change threshold</span>
          )}
          {simStatus === 'failed' && (
            <span className="ml-auto text-xs px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/30 text-amber-600 font-medium">Larger change: review the differences</span>
          )}
          {(simStatus === 'unavailable' || simStatus === 'error') && (
            <span className="ml-auto text-xs px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-500 font-medium">Not available</span>
          )}
        </div>

        {simStatus === 'idle' && (
          <p className="text-sm text-foreground/70 text-center py-4">
            Run the preview to compare this version against the current active policy.
          </p>
        )}
        {simStatus === 'running' && (
          <div className="flex flex-col items-center gap-3 py-4">
            <Loader2 className="w-6 h-6 animate-spin text-brand-500" />
            <p className="text-sm text-foreground/70">Replaying the sample tickets against both versions...</p>
          </div>
        )}
        {(simStatus === 'unavailable' || simStatus === 'error') && (
          <div className="flex items-start gap-2.5 py-1">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="text-sm text-foreground">{notice}</p>
              <p className="text-xs text-foreground/70">
                No impact figures are available for this version. Review the
                generated rules yourself before publishing.
              </p>
            </div>
          </div>
        )}
        {metrics && (simStatus === 'passed' || simStatus === 'failed') && (
          <div className="space-y-2">
            {Object.entries(metrics).map(([k, v]) => (
              <div key={k} className="flex justify-between text-sm">
                <span className="text-foreground/70">{k}</span>
                <span className="text-foreground font-medium font-mono">{v}</span>
              </div>
            ))}
            {simStatus === 'failed' && (
              <p className="text-xs text-amber-600 mt-3 pt-2 border-t border-amber-200 dark:border-amber-700">
                The change rate exceeds the configured threshold. This is not a verdict on quality: check whether the differences match your intended outcome.
              </p>
            )}
          </div>
        )}
      </div>

      <div className="rounded-xl border border-surface-border p-4 text-sm space-y-2">
        <p className="font-medium">What this test tells you</p>
        <p className="text-foreground/70">Up to 1,000 saved simulation cases; no date range or representative sampling is established. The comparison measures final actions, not refund amounts, savings, or customer satisfaction.</p>
        <p className="text-foreground/70">A different decision can be an improvement. Review whether it follows the proposed SOP before making a launch decision.</p>
      </div>
      {runSimMutation.data?.data.metrics?.examples?.length ? <div className="overflow-x-auto">
        <h3 className="text-sm font-semibold mb-2">Examples to review</h3>
        <table className="w-full text-sm text-left"><thead><tr><th className="p-2">Case</th><th className="p-2">Current decision</th><th className="p-2">Proposed decision</th></tr></thead>
          <tbody>{runSimMutation.data.data.metrics.examples.map((example, index) => <tr className="border-t border-surface-border" key={index}><td className="p-2">{example.ticket_id}</td><td className="p-2">{example.baseline}</td><td className="p-2">{example.candidate}</td></tr>)}</tbody></table>
      </div> : null}

      <div className="flex justify-between">
        <button
          onClick={onBack}
          className="flex items-center gap-2 px-4 py-2 text-sm border border-surface-border rounded-lg text-foreground hover:bg-surface transition-colors"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="flex gap-2">
          {simStatus !== 'running' && simStatus !== 'passed' && (
            <button
              onClick={() => runSimMutation.mutate()}
              disabled={runSimMutation.isPending}
              className="flex items-center gap-2 px-5 py-2.5 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-40 transition-colors"
            >
              {runSimMutation.isPending ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Running...</>
              ) : (
                <><BarChart2 className="w-4 h-4" /> {simStatus === 'idle' ? 'Run Preview' : 'Re-run Preview'}</>
              )}
            </button>
          )}
          {simStatus !== 'idle' && simStatus !== 'running' && (
            <button
              onClick={onNext}
              className={cn(
                'flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-colors',
                simStatus === 'passed'
                  ? 'bg-brand-600 text-white hover:bg-brand-700'
                  : 'border border-surface-border text-foreground hover:bg-surface',
              )}
            >
              {simStatus === 'passed'
                ? <>Review launch decision <ArrowRight className="w-4 h-4" /></>
                : <>Review evidence gaps <ArrowRight className="w-4 h-4" /></>
              }
            </button>
          )}
          {simStatus === 'idle' && (
            <button
              onClick={onNext}
              className="flex items-center gap-2 px-4 py-2 text-sm border border-surface-border rounded-lg text-foreground hover:bg-surface transition-colors"
            >
              Review without a test <ArrowRight className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ============================================================
// Step 7 — Publish
// ============================================================

function PublishStep({ kbId, entityId, evidence, onCreated, onBack }: {
  kbId: string; entityId: string; evidence: SimResponse | null; onCreated: () => void; onBack: () => void
}) {
  const qc = useQueryClient()
  const { user } = useAuthStore()
  const canPublish = hasPermission(user, 'policy', 'admin') || !!user?.is_super_admin
  const [acknowledged, setAcknowledged] = useState(false)
  const rules = useQuery({ queryKey: ['rules', kbId, entityId, 'wizard'], queryFn: () => fetchRules(kbId, entityId).then(r => r.data) })
  const categories = useQuery({ queryKey: ['launch-categories', kbId, entityId], queryFn: () => bpmApi.listTaxonomyProposals(kbId, entityId).then(r => r.data) })
  const actions = useQuery({ queryKey: ['launch-actions', kbId, entityId], queryFn: () => bpmApi.listActionProposals(kbId, entityId).then(r => r.data) })
  const instances = useQuery({ queryKey: ['bpm', 'instances', kbId, entityId, 'wizard'], queryFn: () => bpmApi.listInstances(kbId, { entity_id: entityId, limit: 1 }).then(r => r.data), refetchInterval: 15_000 })
  const instance = instances.data?.find(i => i.entity_id === entityId)
  const brief = instance?.metadata?.business_brief as Partial<BusinessBrief> | undefined
  const pending = [...(categories.data ?? []), ...(actions.data ?? [])].filter(p => p.status === 'pending').length
  const loaded = rules.isSuccess && categories.isSuccess && actions.isSuccess && instances.isSuccess
  const hasReview = (categories.data ?? []).some(p => ['accepted', 'edited'].includes(p.status)) && (actions.data ?? []).some(p => ['accepted', 'edited'].includes(p.status))
  const ready = loaded && hasReview && pending === 0 && !!rules.data?.length && instance?.current_stage === 'PENDING_APPROVAL'
  const blockers = !loaded ? ['Review evidence could not be loaded yet. Try again before deciding.'] : [
    ...(!hasReview ? ['Accept at least one customer problem and one proposed response.'] : []),
    ...(pending > 0 ? [`Resolve the ${pending} items still awaiting your review.`] : []),
    ...(!rules.data?.length ? ['Add and review at least one decision.'] : []),
    ...(instance?.current_stage !== 'PENDING_APPROVAL' ? ['This proposal has not reached its launch approval stage. Complete that review in Policy Studio before activation.'] : []),
  ]
  const summary = evidence?.status === 'ok' && evidence.metrics
    ? `${evidence.metrics.changed_count} of ${evidence.metrics.ticket_count} sample cases receive a different final action. ${evidence.passed ? 'Within' : 'Outside'} the configured change threshold.`
    : 'No completed sample comparison is available in this review. Impact has not been established.'
  const mutation = useMutation({ mutationFn: () => publishVersion(kbId, entityId), onSuccess: () => { qc.invalidateQueries({ queryKey: ['bpm', 'instances', kbId] }); onCreated() } })
  const downloadBrief = () => {
    const text = [`# ${brief?.name || 'Policy change'}\n`, `Version: ${entityId}`, `Owner: ${instance?.created_by_name || 'Not available'}`, `Intended outcome: ${brief?.outcome || 'Not supplied'}`, `Intended scope: ${brief?.scope || 'Not supplied; review conditions'}`, '', '## Evidence', summary, `Rules: ${rules.data?.length ?? 'Not available'}; pending review items: ${loaded ? pending : 'Not available'}`, 'Live comparison: not verified by this wizard. No customer-outcome or financial benefit has been established.', '', '## Decision', 'This brief is for review. It is not an approval or proof of activation.'].join('\n')
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }))
    const link = document.createElement('a'); link.href = url; link.download = 'policy-change-brief.md'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <div className="space-y-5">
    <div><p className="text-xs uppercase tracking-widest text-brand-600 mb-2">Business review</p><h2 className="text-xl font-semibold">Make an informed launch decision</h2><p className="text-sm text-foreground/70 mt-2">Review the proposal, the evidence, and the gaps. Sharing this brief does not change the policy serving customers.</p></div>
    <section className="rounded-xl border border-surface-border p-5 space-y-3">
      <h3 className="font-semibold">{brief?.name || 'Proposed policy change'}</h3>
      <dl className="space-y-3 text-sm"><div><dt className="text-foreground/70">Intended business outcome</dt><dd>{brief?.outcome || 'No outcome was supplied with this version.'}</dd></div><div><dt className="text-foreground/70">Intended scope</dt><dd>{brief?.scope || 'Confirm which customers and situations the decision conditions cover.'}</dd></div><div><dt className="text-foreground/70">Proposal owner</dt><dd>{instance?.created_by_name || 'Not available'}</dd></div></dl>
    </section>
    <section className="rounded-xl border border-surface-border p-5 space-y-3 text-sm">
      <h3 className="font-semibold">Evidence, not assumptions</h3>
      <p>{loaded ? `${rules.data?.length ?? 0} proposed decisions · ${pending} review items still open` : 'Review evidence is loading or unavailable. Activation remains disabled.'}</p>
      <p>{summary}</p>
      <p className="text-foreground/70">Live comparison has not been verified by this wizard. A workflow stage alone does not prove cases were evaluated.</p>
      <p className="text-foreground/70">Savings, refund cost and customer satisfaction are not measured by this sample test.</p>
    </section>
    {!ready && <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-900/10 p-4 text-sm text-amber-800 dark:text-amber-300"><strong className="block mb-2">Before this can go live</strong>{blockers.map(reason => <span key={reason} className="block mb-1">{reason}</span>)}<span className="block mt-2">Keep the proposal or download its brief to continue the review.</span></p>}
    {ready && <label className="flex items-start gap-3 text-sm"><input className="mt-1" type="checkbox" checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)} /><span>I have reviewed the evidence and its limitations, and am authorized to replace the current policy for new tickets.</span></label>}
    {mutation.isError && <p role="alert" className="text-sm text-red-600">Activation did not complete. Check the policy status before retrying, or ask your support team for help.</p>}
    <div className="flex flex-wrap gap-2 justify-between"><button className="text-sm underline" onClick={onBack}>Back to impact test</button><div className="flex flex-wrap gap-2"><button className="px-3 py-2 border border-surface-border rounded-lg text-sm" onClick={downloadBrief} disabled={!loaded}>Download review brief</button><button className="px-3 py-2 border border-surface-border rounded-lg text-sm" onClick={onCreated}>Keep proposal & close</button>{canPublish && <button className="px-4 py-2 rounded-lg bg-brand-600 text-white text-sm disabled:opacity-40" onClick={() => mutation.mutate()} disabled={!ready || !acknowledged || mutation.isPending}>{mutation.isPending ? 'Activating…' : 'Activate for new tickets'}</button>}</div></div>
    {!canPublish && <p className="text-xs text-foreground/70">A policy publisher must authorize activation. You can prepare and share the review brief.</p>}
  </div>
}

// ============================================================
// Main Wizard
// ============================================================

export function VersionWizard({ kbId, onClose, onCreated }: Props) {
  const [step, setStep] = useState<Step>(1)
  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => { dialogRef.current?.scrollTo({ top: 0 }); dialogRef.current?.focus() }, [step])
  const [entityId, setEntityId] = useState('')
  const [filename, setFilename] = useState('')
  const [evidence, setEvidence] = useState<SimResponse | null>(null)

  const handleUploadDone = (eid: string, fname: string) => {
    setEntityId(eid); setFilename(fname); setStep(2)
  }

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Create a policy change"
          onKeyDown={event => {
            if (event.key === 'Escape') { event.stopPropagation(); onClose() }
            if (event.key !== 'Tab') return
            const elements = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], summary')).filter(el => el.getClientRects().length)
            const first = elements[0], last = elements[elements.length - 1]
            if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last?.focus() }
            else if (!event.shiftKey && (document.activeElement === last || document.activeElement === event.currentTarget)) { event.preventDefault(); first?.focus() }
          }} className="bg-surface-card border border-surface-border rounded-2xl shadow-2xl w-full max-w-3xl max-h-[92vh] overflow-y-auto">
          <div className="sticky top-0 z-10 bg-surface-card flex items-center justify-between px-6 py-4 border-b border-surface-border">
            <div>
              <p className="text-xs text-foreground/70 font-mono">{kbId}</p>
              <h1 className="text-base font-semibold text-foreground">Create a policy change</h1>
            </div>
            <button aria-label="Close policy change" onClick={onClose} className="text-foreground/70 hover:text-foreground transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="p-6">
            <StepIndicator current={step} />

            {step === 1 && (
              <UploadStep kbId={kbId} onNext={handleUploadDone} />
            )}
            {step === 2 && (
              <AIAnalysisStep
                kbId={kbId}
                entityId={entityId}
                filename={filename}
                onNext={() => setStep(3)}
                onBack={() => setStep(1)}
              />
            )}
            {step === 3 && (
              <TaxonomyReviewStep
                kbId={kbId}
                entityId={entityId}
                onNext={() => setStep(4)}
                onBack={() => setStep(2)}
              />
            )}
            {step === 4 && (
              <ActionReviewStep
                kbId={kbId}
                entityId={entityId}
                onNext={() => setStep(5)}
                onBack={() => setStep(3)}
              />
            )}
            {step === 5 && (
              <ReviewRulesStep
                kbId={kbId}
                entityId={entityId}
                onNext={() => setStep(6)}
                onBack={() => setStep(4)}
              />
            )}
            {step === 6 && (
              <PreviewStep
                kbId={kbId}
                entityId={entityId}
                onNext={() => setStep(7)}
                onBack={() => { setEvidence(null); setStep(5) }}
                onResult={setEvidence}
              />
            )}
            {step === 7 && (
              <PublishStep
                evidence={evidence}
                kbId={kbId}
                entityId={entityId}
                onCreated={onCreated}
                onBack={() => setStep(6)}
              />
            )}
          </div>
        </div>
      </div>
    </>
  )
}
