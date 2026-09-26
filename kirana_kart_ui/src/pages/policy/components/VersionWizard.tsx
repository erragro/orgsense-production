/**
 * VersionWizard — 7-step guided flow for creating a new policy version.
 *
 * Step 1 — Upload Document
 * Step 2 — AI Analysis (extract taxonomy from SOP)
 * Step 3 — Taxonomy Review (accept / edit / reject each issue node)
 * Step 4 — Action Review (accept / edit / reject each extracted action)
 * Step 5 — Rules Review (deterministically generated rules, inline editing)
 * Step 6 — Preview (sample decision comparison — the server records it as a gate)
 * Step 7 — Request approval (another policy administrator approves and activates)
 *
 * The server advances the proposal's stage as each step's work completes, so
 * a proposal can be closed and resumed (resumeEntityId) at any point.
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
import { apiErrorMessage } from '@/lib/api-error'
import { governanceClient as apiClient } from '@/api/clients'
import { ruleApi } from '@/api/governance/rule-editor.api'
import {
  bpmApi,
  type TaxonomyProposal,
  type ActionProposal,
  type ReviewProposalPayload,
  type SimulationGateResult,
  type SkippedPairing,
} from '@/api/governance/bpm.api'

interface Props {
  kbId: string
  /** Continue an existing proposal instead of uploading a new SOP. */
  resumeEntityId?: string
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
    action_id: number
    action_name: string
    priority: number
    conditions: Record<string, unknown>
    min_order_value: number | null
    max_order_value: number | null
    deterministic: boolean
    action_payload: RulePayload | null
  }>>(`/rules/${kbId}`, { params: { version } })

/** Amounts the runtime applies when this rule decides (see rule_engine.py). */
type RulePayload = { refund_amount?: number; refund_percent?: number; max_refund?: number }


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
    onError: (e: unknown) => setError(apiErrorMessage(e, 'Upload failed. Please try again.')),
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
  const [truncation, setTruncation] = useState('')

  const extractMut = useMutation({
    mutationFn: () => bpmApi.extractTaxonomy(kbId, entityId),
    onMutate: () => { setStatus('running'); setFindings([]) },
    onSuccess: (res) => {
      setStatus('done')
      const proposals: TaxonomyProposal[] = res.data.proposals ?? []
      setTruncation(res.data.truncated
        ? `Only the first ${res.data.analysed_characters.toLocaleString()} of ${res.data.document_characters.toLocaleString()} characters were analysed. Check that the rest of your SOP is covered, or split it into separate proposals.`
        : '')
      const newCount = proposals.filter((p) => p.proposal_type === 'new').length
      const existingCount = proposals.filter((p) => p.proposal_type === 'existing').length
      setFindings([
        `${proposals.length} issue categories identified`,
        newCount > 0 ? `${newCount} new categories to review` : 'All categories already in registry',
        existingCount > 0 ? `${existingCount} matched to existing taxonomy` : '',
        'Ready for your review',
      ].filter(Boolean))
    },
    onError: (e: unknown) => {
      setStatus('error'); setError(apiErrorMessage(e, 'Analysis failed. Please try again.'))
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

        {truncation && (
          <div role="status" className="flex items-start gap-2 text-sm text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-700 rounded-lg p-3 mt-3">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            {truncation}
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
            onClick={() => onNext(findings.length)}
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
  const reviewError = reviewMut.isError ? apiErrorMessage(reviewMut.error, 'Could not save this review.') : ''


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
            {reviewError && <p role="alert" className="text-xs text-red-600 mt-1">{reviewError}</p>}
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
    onError: refresh,
  })

  return (
    <div className="space-y-4">
      {acceptAll.isError && <p role="alert" className="text-sm text-red-600">{apiErrorMessage(acceptAll.error, 'Some items could not be accepted.')}</p>}
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
  const reviewError = reviewMut.isError ? apiErrorMessage(reviewMut.error, 'Could not save this review.') : ''


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
            {reviewError && <p role="alert" className="text-xs text-red-600 mt-1">{reviewError}</p>}
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

  const { data: actions = [], isLoading, isSuccess } = useQuery({
    queryKey: qKey,
    queryFn: () => bpmApi.listActionProposals(kbId, entityId).then(r => r.data),
  })
  // Responses already identified for this proposal (e.g. when resuming) are
  // reviewed in place. Identifying again replaces them and their reviews.
  const hasActions = isSuccess && actions.length > 0
  const showList = extractStatus === 'done' || (extractStatus === 'idle' && hasActions)

  const refresh = () => qc.invalidateQueries({ queryKey: qKey })

  const extractMut = useMutation({
    mutationFn: () => bpmApi.extractActions(kbId, entityId),
    onMutate: () => { setExtractStatus('running'); setExtractError('') },
    onSuccess: () => { setExtractStatus('done'); refresh() },
    onError: (e: unknown) => { setExtractStatus('error'); setExtractError(apiErrorMessage(e, 'Extraction failed.')) },
  })

  const acceptAll = useMutation({
    mutationFn: async () => {
      const pendingActions = (actions as ActionProposal[]).filter(a => a.status === 'pending')
      for (const a of pendingActions) {
        await bpmApi.reviewActionProposal(kbId, a.id, { status: 'accepted' })
      }
    },
    onSuccess: refresh,
    onError: refresh,
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

      {extractStatus === 'idle' && !hasActions && (
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

      {acceptAll.isError && <p role="alert" className="text-sm text-red-600">{apiErrorMessage(acceptAll.error, 'Some items could not be accepted.')}</p>}
      {showList && (
        <>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 text-xs text-foreground/70">
              <span className="text-green-600 font-medium">{accepted} accepted</span>
              <span>·</span>
              <span>{pending} pending</span>
            </div>
            {extractStatus === 'idle' && (
              <button
                onClick={() => { if (window.confirm('Identify responses again? This replaces the responses below and your review of them.')) extractMut.mutate() }}
                className="text-xs underline text-foreground/70"
              >
                Identify again
              </button>
            )}
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
  action_id: number
  action_name: string
  priority: number
  conditions: Record<string, unknown>
  min_order_value: number | null
  max_order_value: number | null
  deterministic: boolean
  action_payload: RulePayload | null
}

type AmountMode = 'ai' | 'fixed' | 'percent'

type EditDraft = {
  issue_type_l1: string
  issue_type_l2: string
  action_id: number | null
  priority: number
  min_order_value: string
  max_order_value: string
  amount_mode: AmountMode
  amount_value: string
  max_refund: string
}

// Rules are evaluated in priority order: the lower number wins.
const DEFAULT_PRIORITY = 500

const BLANK_DRAFT: EditDraft = {
  issue_type_l1: '',
  issue_type_l2: '',
  action_id: null,
  priority: DEFAULT_PRIORITY,
  min_order_value: '',
  max_order_value: '',
  amount_mode: 'ai',
  amount_value: '',
  max_refund: '',
}

const draftAmounts = (payload: RulePayload | null) => ({
  amount_mode: (payload?.refund_amount != null ? 'fixed' : payload?.refund_percent != null ? 'percent' : 'ai') as AmountMode,
  amount_value: String(payload?.refund_amount ?? payload?.refund_percent ?? ''),
  max_refund: payload?.max_refund != null ? String(payload.max_refund) : '',
})

const toPayload = (draft: EditDraft) => {
  const action_payload: RulePayload = {}
  if (draft.amount_mode === 'fixed' && draft.amount_value) action_payload.refund_amount = parseFloat(draft.amount_value)
  if (draft.amount_mode === 'percent' && draft.amount_value) action_payload.refund_percent = parseFloat(draft.amount_value)
  if (draft.max_refund) action_payload.max_refund = parseFloat(draft.max_refund)
  return {
    issue_type_l1: draft.issue_type_l1.trim(),
    issue_type_l2: draft.issue_type_l2.trim() || null,
    action_id: draft.action_id,
    priority: draft.priority,
    min_order_value: draft.min_order_value ? parseFloat(draft.min_order_value) : null,
    max_order_value: draft.max_order_value ? parseFloat(draft.max_order_value) : null,
    action_payload,
  }
}

/** Plain-English amount a deciding rule gives. */
function amountSummary(payload: RulePayload | null): string {
  const parts: string[] = []
  if (payload?.refund_amount != null) parts.push(`Refund ₹${payload.refund_amount}`)
  else if (payload?.refund_percent != null) parts.push(`Refund ${payload.refund_percent}% of order`)
  else parts.push('Amount proposed by the AI')
  if (payload?.max_refund != null) parts.push(`capped at ₹${payload.max_refund}`)
  return parts.join(', ')
}

function RuleFields({ kbId, draft, setDraft }: {
  kbId: string
  draft: EditDraft
  setDraft: (update: (d: EditDraft) => EditDraft) => void
}) {
  const actionCodes = useQuery({
    queryKey: ['rule-action-codes', kbId],
    queryFn: () => ruleApi.listActionCodes(kbId).then(r => r.data),
    staleTime: 60_000,
  })
  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <label className="text-xs text-foreground/70 block">Customer problem *
          <input className={inp + ' mt-0.5'} value={draft.issue_type_l1}
            onChange={e => setDraft(d => ({ ...d, issue_type_l1: e.target.value }))}
            placeholder="e.g. FOOD_SAFETY" />
        </label>
        <label className="text-xs text-foreground/70 block">More specific situation
          <input className={inp + ' mt-0.5'} value={draft.issue_type_l2}
            onChange={e => setDraft(d => ({ ...d, issue_type_l2: e.target.value }))}
            placeholder="e.g. FOREIGN_OBJECT" />
        </label>
      </div>
      <label className="text-xs text-foreground/70 block">Action to take *
        <select className={inp + ' mt-0.5'} value={draft.action_id ?? ''}
          onChange={e => setDraft(d => ({ ...d, action_id: e.target.value ? Number(e.target.value) : null }))}>
          <option value="">{actionCodes.isLoading ? 'Loading actions…' : 'Choose an action'}</option>
          {(actionCodes.data ?? []).map(a => (
            <option key={a.id} value={a.id}>{a.action_name || a.action_code_id} ({a.action_code_id})</option>
          ))}
        </select>
      </label>
      {actionCodes.isError && <p className="text-xs text-red-500">{apiErrorMessage(actionCodes.error, 'Actions could not be loaded.')}</p>}
      <div className="grid grid-cols-3 gap-2">
        <label className="text-xs text-foreground/70 block">Priority (lower wins)
          <input className={inp + ' mt-0.5'} type="number" min={0} max={999} value={draft.priority}
            onChange={e => setDraft(d => ({ ...d, priority: (Number.isNaN(Number.parseInt(e.target.value, 10)) ? DEFAULT_PRIORITY : Number.parseInt(e.target.value, 10)) }))} />
        </label>
        <label className="text-xs text-foreground/70 block">Min order (₹)
          <input className={inp + ' mt-0.5'} type="number" min={0} value={draft.min_order_value}
            onChange={e => setDraft(d => ({ ...d, min_order_value: e.target.value }))}
            placeholder="Any" />
        </label>
        <label className="text-xs text-foreground/70 block">Max order (₹)
          <input className={inp + ' mt-0.5'} type="number" min={0} value={draft.max_order_value}
            onChange={e => setDraft(d => ({ ...d, max_order_value: e.target.value }))}
            placeholder="Any" />
        </label>
      </div>
      <fieldset className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <legend className="text-xs text-foreground/70 mb-0.5">Amount when this rule decides</legend>
        <label className="text-xs text-foreground/70 block">Refund
          <select className={inp + ' mt-0.5'} aria-label="Refund amount source" value={draft.amount_mode}
            onChange={e => setDraft(d => ({ ...d, amount_mode: e.target.value as AmountMode, amount_value: '' }))}>
            <option value="ai">Proposed by the AI</option>
            <option value="fixed">Fixed amount (₹)</option>
            <option value="percent">% of order value</option>
          </select>
        </label>
        {draft.amount_mode !== 'ai' && (
          <label className="text-xs text-foreground/70 block">{draft.amount_mode === 'fixed' ? 'Amount (₹)' : 'Percent of order'}
            <input className={inp + ' mt-0.5'} type="number" min={0} max={draft.amount_mode === 'percent' ? 100 : undefined}
              value={draft.amount_value} onChange={e => setDraft(d => ({ ...d, amount_value: e.target.value }))} />
          </label>
        )}
        <label className="text-xs text-foreground/70 block">Never more than (₹)
          <input className={inp + ' mt-0.5'} type="number" min={0} value={draft.max_refund}
            onChange={e => setDraft(d => ({ ...d, max_refund: e.target.value }))} placeholder="No cap" />
        </label>
      </fieldset>
    </>
  )
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
    action_id: rule.action_id,
    priority: rule.priority,
    min_order_value: rule.min_order_value != null ? String(rule.min_order_value) : '',
    max_order_value: rule.max_order_value != null ? String(rule.max_order_value) : '',
    ...draftAmounts(rule.action_payload),
  })

  const saveMut = useMutation({
    mutationFn: () => apiClient.put(`/rules/${kbId}/${rule.id}`, toPayload(draft)),
    onSuccess: () => { setEditing(false); onSaved() },
  })

  const delMut = useMutation({
    mutationFn: () => apiClient.delete(`/rules/${kbId}/${rule.id}`),
    onSuccess: onDeleted,
  })
  const error = saveMut.isError ? apiErrorMessage(saveMut.error, 'Could not save. Please check the fields and try again.')
    : delMut.isError ? apiErrorMessage(delMut.error, 'Could not remove this rule.') : ''

  if (editing) {
    return (
      <div className="bg-surface-card border border-brand-500/40 rounded-xl p-4 space-y-3">
        <RuleFields kbId={kbId} draft={draft} setDraft={setDraft} />
        {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
        <div className="flex gap-2 justify-end">
          <button onClick={() => setEditing(false)}
            className="px-3 py-1.5 text-sm border border-surface-border rounded-lg text-foreground hover:bg-surface transition-colors">
            Cancel
          </button>
          <button
            onClick={() => saveMut.mutate()}
            disabled={saveMut.isPending || !draft.issue_type_l1.trim() || !draft.action_id}
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
            <span className="text-xs font-mono text-foreground/70 break-all">{rule.rule_id}</span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-blue-50 dark:bg-blue-900/20 text-blue-600 font-medium">
              {rule.issue_type_l1}{rule.issue_type_l2 ? ` › ${rule.issue_type_l2}` : ''}
            </span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-surface text-foreground/70 border border-surface-border">
              Priority {rule.priority}
            </span>
            {rule.deterministic ? (
              <span className="text-xs text-green-600 bg-green-50 dark:bg-green-900/20 px-2 py-0.5 rounded-full" title="When it matches, this rule sets the decision">Decides</span>
            ) : (
              <span className="text-xs text-foreground/70 bg-surface border border-surface-border px-2 py-0.5 rounded-full" title="Shown to the AI as guidance only">Guidance</span>
            )}
          </div>
          <p className="text-sm font-medium text-foreground mt-1.5">{rule.action_name}</p>
          {rule.deterministic && <p className="text-xs text-foreground/70 mt-0.5">{amountSummary(rule.action_payload)}</p>}
          {(rule.min_order_value != null || rule.max_order_value != null) && (
            <p className="text-xs text-foreground/70 mt-0.5">
              Order value:{' '}
              {rule.min_order_value != null ? `≥ ₹${rule.min_order_value}` : ''}
              {rule.min_order_value != null && rule.max_order_value != null ? ' · ' : ''}
              {rule.max_order_value != null ? `≤ ₹${rule.max_order_value}` : ''}
            </p>
          )}
          {error && <p role="alert" className="text-xs text-red-500 mt-1">{error}</p>}
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

  const addMut = useMutation({
    mutationFn: () => apiClient.post(`/rules/${kbId}`, { policy_version: entityId, ...toPayload(draft) }),
    onSuccess: () => { setOpen(false); setDraft(BLANK_DRAFT); onAdded() },
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
      <RuleFields kbId={kbId} draft={draft} setDraft={setDraft} />
      {addMut.isError && <p role="alert" className="text-xs text-red-500">{apiErrorMessage(addMut.error, 'Could not add rule. Please fill in all required fields.')}</p>}
      <div className="flex gap-2 justify-end">
        <button onClick={() => { setOpen(false); setDraft(BLANK_DRAFT); addMut.reset() }}
          className="px-3 py-1.5 text-sm border border-surface-border rounded-lg text-foreground hover:bg-surface transition-colors">
          Cancel
        </button>
        <button
          onClick={() => addMut.mutate()}
          disabled={addMut.isPending || !draft.issue_type_l1.trim() || !draft.action_id}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-40 transition-colors">
          <Plus className="w-3.5 h-3.5" />
          {addMut.isPending ? 'Adding…' : 'Add Rule'}
        </button>
      </div>
    </div>
  )
}

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
  const [skipped, setSkipped] = useState<SkippedPairing[]>([])
  const autoGenerated = useRef(false)

  const rulesQuery = useQuery({
    queryKey: qKey,
    queryFn: () => fetchRules(kbId, entityId).then(r => r.data as unknown as Rule[]),
  })
  const rules = rulesQuery.data ?? []

  const refresh = () => qc.invalidateQueries({ queryKey: qKey })

  const generateMut = useMutation({
    mutationFn: () => bpmApi.generateRules(kbId, entityId),
    onSuccess: (res) => { setSkipped(res.data.skipped ?? []); refresh() },
  })

  // Generate once for a proposal with no decisions yet. Regenerating replaces
  // manual changes, so it never happens implicitly when decisions exist.
  useEffect(() => {
    if (rulesQuery.isSuccess && rules.length === 0 && !autoGenerated.current) {
      autoGenerated.current = true
      generateMut.mutate()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rulesQuery.isSuccess, rules.length])

  const regenerate = () => {
    if (window.confirm('Regenerate decisions from the reviewed problems and responses? Manual changes to the decisions below will be replaced.')) {
      generateMut.mutate()
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Review the proposed decisions</h2>
        <p className="text-sm text-foreground/70 mt-1">
          Check the connection: when this customer problem occurs, under these conditions, take this action. Remove combinations that your SOP does not authorize.
        </p>
      </div>

      {generateMut.isPending && (
        <div className="flex items-center justify-center gap-2 py-6 text-sm text-foreground/70">
          <Loader2 className="w-5 h-5 animate-spin text-brand-500" />
          Connecting customer problems to their proposed responses...
        </div>
      )}

      {generateMut.isError && (
        <div role="alert" className="flex items-center gap-2 text-sm text-red-600 bg-red-50 dark:bg-red-900/10 border border-red-200 rounded-lg p-3">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {apiErrorMessage(generateMut.error, 'Generation failed.')}
          <button onClick={() => generateMut.mutate()} className="ml-auto underline text-xs">Retry</button>
        </div>
      )}

      {skipped.length > 0 && (
        <div role="status" className="text-sm text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-700 rounded-lg p-3 space-y-1">
          <p className="font-medium">{skipped.length} accepted pairing{skipped.length !== 1 ? 's' : ''} could not become a decision</p>
          {skipped.slice(0, 5).map(s => (
            <p key={`${s.issue_code}-${s.action_code_id}`} className="text-xs">{s.action_code_id} for {s.issue_code}: {s.reason}</p>
          ))}
        </div>
      )}

      {rulesQuery.isLoading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="w-6 h-6 animate-spin text-brand-500" />
        </div>
      ) : rulesQuery.isError ? (
        <p role="alert" className="text-sm text-red-600">{apiErrorMessage(rulesQuery.error, 'Decisions could not be loaded.')}</p>
      ) : rules.length === 0 && !generateMut.isPending ? (
        <div className="text-center py-6 text-sm text-foreground/70">
          No rules generated. Add rules manually below.
        </div>
      ) : (
        <div className="space-y-2 max-h-[380px] overflow-y-auto pr-1">
          {rules.map((rule) => (
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
        <div className="flex items-center justify-between text-xs text-foreground/70">
          <span>{rules.length} rule{rules.length !== 1 ? 's' : ''}</span>
          <button onClick={regenerate} disabled={generateMut.isPending} className="underline disabled:opacity-40">
            Regenerate from reviewed proposals
          </button>
        </div>
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
          disabled={generateMut.isPending || rules.length === 0}
          className="flex items-center gap-2 px-5 py-2.5 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-40 transition-colors"
        >
          Compare sample decisions <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}

// ============================================================
// Step 6 — Preview (sample decision comparison)
// ============================================================

type SimStatus = 'idle' | 'running' | 'passed' | 'failed' | 'not_applicable' | 'unavailable' | 'error'

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
  onResult: (result: SimulationGateResult | null) => void
}) {
  const [simStatus, setSimStatus] = useState<SimStatus>('idle')
  const [metrics, setMetrics] = useState<Record<string, string> | null>(null)
  const [notice, setNotice] = useState('')

  const runSimMutation = useMutation({
    mutationFn: () => bpmApi.simulate(kbId, entityId),
    onMutate: () => { onResult(null); setSimStatus('running'); setNotice(''); setMetrics(null) },
    onSuccess: (res) => {
      const { status, passed, reason, metrics: m } = res.data

      // The gate reports honestly when it cannot run. It previously fell
      // back to a hardcoded 0.94, so the reviewer was shown a confident
      // "94.0% unchanged" for a simulation that never happened.
      if (status === 'unavailable' || !m) {
        setSimStatus('unavailable')
        setNotice(reason || 'The preview could not be run for this version.')
        return
      }
      onResult(res.data)
      if (status === 'not_applicable') {
        setSimStatus('not_applicable')
        setNotice(reason || 'No policy is live yet, so there is nothing to compare against.')
        return
      }

      setSimStatus(passed ? 'passed' : 'failed')
      setMetrics({
        'Decisions unchanged': `${((m.unchanged_rate ?? 0) * 100).toFixed(1)}%`,
        'Decisions different': `${((1 - (m.unchanged_rate ?? 0)) * 100).toFixed(1)}%`,
        'Tickets tested': String(m.ticket_count),
        'Decisions changed': String(m.changed_count),
        'Compared against': m.baseline_version ?? '',
      })
    },
    onError: (e: unknown) => {
      setSimStatus('error')
      setNotice(apiErrorMessage(e, 'The comparison could not be completed. Try again or ask your support team for help.'))
    },
  })

  const examples = runSimMutation.data?.data.examples ?? []
  const recorded = simStatus === 'passed' || simStatus === 'failed' || simStatus === 'not_applicable'

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">What would change?</h2>
        <p className="text-sm text-foreground/70 mt-1">
          Compare the current and proposed policies on saved sample cases. This replay does not change customer decisions. The result is recorded with the proposal for its approver.
        </p>
      </div>

      <div className={cn(
        'rounded-xl border p-5',
        simStatus === 'passed'
          ? 'border-green-200 dark:border-green-700 bg-green-50 dark:bg-green-900/10'
          : simStatus === 'failed' || simStatus === 'unavailable' || simStatus === 'error'
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
          {simStatus === 'not_applicable' && (
            <span className="ml-auto text-xs px-2 py-0.5 rounded-full bg-surface text-foreground/70 border border-surface-border font-medium">First live version</span>
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
                No impact figures are available, and approval cannot be requested until the comparison runs.
              </p>
            </div>
          </div>
        )}
        {simStatus === 'not_applicable' && (
          <p className="text-sm text-foreground">{notice} No decision impact is measured; the approver reviews the decisions themselves.</p>
        )}
        {metrics && (simStatus === 'passed' || simStatus === 'failed') && (
          <div className="space-y-2">
            {Object.entries(metrics).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4 text-sm">
                <span className="text-foreground/70">{k}</span>
                <span className="text-foreground font-medium font-mono text-right break-all">{v}</span>
              </div>
            ))}
            {simStatus === 'failed' && (
              <p className="text-xs text-amber-600 mt-3 pt-2 border-t border-amber-200 dark:border-amber-700">
                The change rate exceeds the configured threshold. This is not a verdict on quality: revise the decisions, or explain why the change is intended when requesting approval.
              </p>
            )}
          </div>
        )}
      </div>

      <div className="rounded-xl border border-surface-border p-4 text-sm space-y-2">
        <p className="font-medium">What this test tells you</p>
        <p className="text-foreground/70">Up to 1,000 saved simulation cases; no date range or representative sampling is established. The comparison measures final actions, not refund amounts, savings, or customer satisfaction.</p>
        <p className="text-foreground/70">It applies each version's rules in priority order, as the live system ranks them. The live system also uses AI judgement on each ticket, so real decisions can differ from this replay.</p>
        <p className="text-foreground/70">A different decision can be an improvement. Review whether it follows the proposed SOP before making a launch decision.</p>
      </div>
      {examples.length ? <div className="overflow-x-auto">
        <h3 className="text-sm font-semibold mb-2">Examples to review</h3>
        <table className="w-full text-sm text-left"><thead><tr><th className="p-2">Case</th><th className="p-2">Current decision</th><th className="p-2">Proposed decision</th></tr></thead>
          <tbody>{examples.map((example, index) => <tr className="border-t border-surface-border" key={index}><td className="p-2">{example.ticket_id}</td><td className="p-2">{example.baseline}</td><td className="p-2">{example.candidate}</td></tr>)}</tbody></table>
      </div> : null}

      <div className="flex justify-between">
        <button
          onClick={onBack}
          className="flex items-center gap-2 px-4 py-2 text-sm border border-surface-border rounded-lg text-foreground hover:bg-surface transition-colors"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="flex gap-2">
          {simStatus !== 'running' && simStatus !== 'passed' && simStatus !== 'not_applicable' && (
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
          {simStatus !== 'running' && (
            <button
              onClick={onNext}
              className={cn(
                'flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-colors',
                simStatus === 'passed' || simStatus === 'not_applicable'
                  ? 'bg-brand-600 text-white hover:bg-brand-700'
                  : 'border border-surface-border text-foreground hover:bg-surface',
              )}
            >
              {recorded && simStatus !== 'failed'
                ? <>Request approval <ArrowRight className="w-4 h-4" /></>
                : simStatus === 'failed'
                  ? <>Review evidence gaps <ArrowRight className="w-4 h-4" /></>
                  : <>Continue without a test <ArrowRight className="w-4 h-4" /></>
              }
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ============================================================
// Step 7 — Request approval
// ============================================================

const MIN_JUSTIFICATION = 20

function SubmitStep({ kbId, entityId, evidence, onCreated, onBack }: {
  kbId: string; entityId: string; evidence: SimulationGateResult | null; onCreated: () => void; onBack: () => void
}) {
  const qc = useQueryClient()
  const { user } = useAuthStore()
  const canApprove = hasPermission(user, 'policy', 'admin') || !!user?.is_super_admin
  const [justification, setJustification] = useState('')
  const rules = useQuery({ queryKey: ['rules', kbId, entityId, 'wizard'], queryFn: () => fetchRules(kbId, entityId).then(r => r.data) })
  const instances = useQuery({ queryKey: ['bpm', 'instances', kbId, entityId, 'wizard'], queryFn: () => bpmApi.listInstances(kbId, { entity_id: entityId, limit: 1 }).then(r => r.data), refetchInterval: 15_000 })
  const readiness = useQuery({ queryKey: ['bpm', 'readiness', kbId, entityId], queryFn: () => bpmApi.getReadiness(kbId, entityId).then(r => r.data), refetchInterval: 15_000 })
  const instance = instances.data?.find(i => i.entity_id === entityId)
  const brief = instance?.metadata?.business_brief as Partial<BusinessBrief> | undefined
  const review = readiness.data?.review
  const stage = readiness.data?.stage ?? instance?.current_stage
  const pending = review ? review.taxonomy_pending + review.actions_pending : 0
  const loaded = rules.isSuccess && instances.isSuccess && readiness.isSuccess
  const needsJustification = stage === 'SIMULATION_FAILED'
  const submitted = stage === 'PENDING_APPROVAL'
  const blockers = !loaded ? ['Review evidence could not be loaded yet. Try again before deciding.'] : [
    ...(pending > 0 ? [`Resolve the ${pending} items still awaiting your review.`] : []),
    ...(!review?.rules ? ['Add and review at least one decision.'] : []),
    ...(!submitted && stage !== 'SHADOW_GATE' && stage !== 'SIMULATION_FAILED'
      ? ['Run the sample decision comparison (previous step) before requesting approval.'] : []),
  ]
  const ready = loaded && !submitted && blockers.length === 0 &&
    (!needsJustification || justification.trim().length >= MIN_JUSTIFICATION)
  const m = evidence?.metrics
  const summary = evidence?.status === 'ok' && m
    ? `${m.changed_count} of ${m.ticket_count} sample cases receive a different final action. ${evidence.passed ? 'Within' : 'Outside'} the configured change threshold.`
    : evidence?.status === 'not_applicable'
      ? 'No policy is live yet, so no existing decision changes. Impact on new tickets has not been measured.'
      : 'No sample comparison was run in this session. The recorded result is shown to the approver in the proposal’s Gates tab.'
  const mutation = useMutation({
    mutationFn: () => bpmApi.submitForApproval(kbId, entityId, needsJustification ? justification.trim() : undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bpm', 'instances', kbId] })
      readiness.refetch(); instances.refetch()
    },
  })
  const downloadBrief = () => {
    const text = [`# ${brief?.name || 'Policy change'}\n`, `Version: ${entityId}`, `Owner: ${instance?.created_by_name || 'Not available'}`, `Intended outcome: ${brief?.outcome || 'Not supplied'}`, `Intended scope: ${brief?.scope || 'Not supplied; review conditions'}`, '', '## Evidence', summary, `Rules: ${review?.rules ?? 'Not available'}; pending review items: ${loaded ? pending : 'Not available'}`, ...(needsJustification && justification.trim() ? [`Justification for the larger change: ${justification.trim()}`] : []), 'Live comparison: not verified by this wizard. No customer-outcome or financial benefit has been established.', '', '## Decision', 'This brief is for review. It is not an approval or proof of activation.'].join('\n')
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }))
    const link = document.createElement('a'); link.href = url; link.download = 'policy-change-brief.md'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <div className="space-y-5">
    <div><p className="text-xs uppercase tracking-widest text-brand-600 mb-2">Business review</p><h2 className="text-xl font-semibold">Request a launch decision</h2><p className="text-sm text-foreground/70 mt-2">Review the proposal, the evidence and the gaps, then ask another policy administrator to approve it. Nothing changes for customers until they approve.</p></div>
    <section className="rounded-xl border border-surface-border p-5 space-y-3">
      <h3 className="font-semibold">{brief?.name || 'Proposed policy change'}</h3>
      <dl className="space-y-3 text-sm"><div><dt className="text-foreground/70">Intended business outcome</dt><dd>{brief?.outcome || 'No outcome was supplied with this version.'}</dd></div><div><dt className="text-foreground/70">Intended scope</dt><dd>{brief?.scope || 'Confirm which customers and situations the decision conditions cover.'}</dd></div><div><dt className="text-foreground/70">Proposal owner</dt><dd>{instance?.created_by_name || 'Not available'}</dd></div></dl>
    </section>
    <section className="rounded-xl border border-surface-border p-5 space-y-3 text-sm">
      <h3 className="font-semibold">Evidence, not assumptions</h3>
      <p>{loaded ? `${review?.rules ?? 0} proposed decision${review?.rules === 1 ? '' : 's'} · ${pending} review item${pending === 1 ? '' : 's'} still open` : 'Review evidence is loading or unavailable.'}</p>
      <p>{summary}</p>
      <p className="text-foreground/70">Live comparison has not been verified by this wizard. A workflow stage alone does not prove cases were evaluated.</p>
      <p className="text-foreground/70">Savings, refund cost and customer satisfaction are not measured by this sample test.</p>
    </section>
    {submitted && <p role="status" className="rounded-lg border border-green-300 bg-green-50 dark:bg-green-900/10 p-4 text-sm text-green-800 dark:text-green-300">
      Submitted for approval. Runtime preparation: {readiness.data?.preparation_status ?? 'not started'}. {canApprove ? 'Another policy administrator approves and activates it from the proposal on the Policy Studio board.' : 'A policy administrator approves and activates it from the Policy Studio board.'}
    </p>}
    {!submitted && blockers.length > 0 && <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-900/10 p-4 text-sm text-amber-800 dark:text-amber-300"><strong className="block mb-2">Before approval can be requested</strong>{blockers.map(reason => <span key={reason} className="block mb-1">{reason}</span>)}<span className="block mt-2">Keep the proposal or download its brief to continue the review.</span></p>}
    {!submitted && needsJustification && blockers.length === 0 && <label className="block text-sm font-medium">Why is this larger change intended?
      <textarea className={inp + ' mt-1'} rows={3} maxLength={2000} value={justification} onChange={e => setJustification(e.target.value)} placeholder="e.g. Replacements are now the promised remedy for missing items, so most refund decisions are expected to change." />
      <span className="block text-xs text-foreground/70 font-normal mt-1">Recorded with the approval request. At least {MIN_JUSTIFICATION} characters.</span>
    </label>}
    {mutation.isError && <p role="alert" className="text-sm text-red-600">{apiErrorMessage(mutation.error, 'The approval request could not be created. Nothing was changed.')}</p>}
    <div className="flex flex-wrap gap-2 justify-between"><button className="text-sm underline" onClick={onBack}>Back to impact test</button><div className="flex flex-wrap gap-2"><button className="px-3 py-2 border border-surface-border rounded-lg text-sm" onClick={downloadBrief} disabled={!loaded}>Download review brief</button><button className="px-3 py-2 border border-surface-border rounded-lg text-sm" onClick={onCreated}>{submitted ? 'Close' : 'Keep proposal & close'}</button>{!submitted && <button className="px-4 py-2 rounded-lg bg-brand-600 text-white text-sm disabled:opacity-40" onClick={() => mutation.mutate()} disabled={!ready || mutation.isPending}>{mutation.isPending ? 'Submitting…' : 'Request approval'}</button>}</div></div>
  </div>
}

// ============================================================
// Main Wizard
// ============================================================

/** Where a resumed proposal picks up, from what already exists for it. */
async function resumeStep(kbId: string, entityId: string): Promise<{ step: Step; filename: string }> {
  const [instances, taxonomy, actions, rules] = await Promise.all([
    bpmApi.listInstances(kbId, { entity_id: entityId, limit: 1 }).then(r => r.data),
    bpmApi.listTaxonomyProposals(kbId, entityId).then(r => r.data),
    bpmApi.listActionProposals(kbId, entityId).then(r => r.data),
    fetchRules(kbId, entityId).then(r => r.data),
  ])
  const instance = instances[0]
  const brief = instance?.metadata?.business_brief as Partial<BusinessBrief> | undefined
  const filename = brief?.name || entityId
  const stage = instance?.current_stage
  if (stage === 'PENDING_APPROVAL' || stage === 'SHADOW_GATE' || stage === 'SIMULATION_FAILED') return { step: 7, filename }
  if (rules.length) return { step: 5, filename }
  if (actions.length) return { step: 4, filename }
  if (taxonomy.length) return { step: 3, filename }
  return { step: 2, filename }
}

export function VersionWizard({ kbId, resumeEntityId, onClose, onCreated }: Props) {
  const resume = useQuery({
    queryKey: ['wizard-resume', kbId, resumeEntityId],
    queryFn: () => resumeStep(kbId, resumeEntityId!),
    enabled: !!resumeEntityId,
    staleTime: Infinity,
    gcTime: 0,
  })
  const resuming = !!resumeEntityId && !resume.data

  // Until the user navigates, a resumed proposal opens where its data ends.
  const [chosenStep, setStep] = useState<Step | null>(null)
  const step: Step = chosenStep ?? resume.data?.step ?? 1
  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => { dialogRef.current?.scrollTo({ top: 0 }); dialogRef.current?.focus() }, [step])
  // Escape must close the dialog even when focus has left it (e.g. the
  // focused button unmounted after submitting).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  const [entityId, setEntityId] = useState(resumeEntityId ?? '')
  const [uploadedName, setFilename] = useState('')
  const filename = uploadedName || resume.data?.filename || ''
  const [evidence, setEvidence] = useState<SimulationGateResult | null>(null)

  const handleUploadDone = (eid: string, fname: string) => {
    setEntityId(eid); setFilename(fname); setStep(2)
  }

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Create a policy change"
          onKeyDown={event => {
            if (event.key !== 'Tab') return
            const elements = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], summary')).filter(el => el.getClientRects().length)
            const first = elements[0], last = elements[elements.length - 1]
            if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last?.focus() }
            else if (!event.shiftKey && (document.activeElement === last || document.activeElement === event.currentTarget)) { event.preventDefault(); first?.focus() }
          }} className="bg-surface-card border border-surface-border rounded-2xl shadow-2xl w-full max-w-3xl max-h-[92vh] overflow-y-auto">
          <div className="sticky top-0 z-10 bg-surface-card flex items-center justify-between px-6 py-4 border-b border-surface-border">
            <div className="min-w-0">
              <p className="text-xs text-foreground/70 font-mono truncate">{entityId || kbId}</p>
              <h1 className="text-base font-semibold text-foreground">{resumeEntityId ? 'Continue a policy change' : 'Create a policy change'}</h1>
            </div>
            <button aria-label="Close policy change" onClick={onClose} className="text-foreground/70 hover:text-foreground transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="p-6">
            <StepIndicator current={step} />

            {resuming && (
              resume.isError
                ? <p role="alert" className="text-sm text-red-600">{apiErrorMessage(resume.error, 'This proposal could not be loaded.')}</p>
                : <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-brand-500" /></div>
            )}

            {!resuming && step === 1 && (
              <UploadStep kbId={kbId} onNext={handleUploadDone} />
            )}
            {!resuming && step === 2 && (
              <AIAnalysisStep
                kbId={kbId}
                entityId={entityId}
                filename={filename}
                onNext={() => setStep(3)}
                onBack={() => setStep(1)}
              />
            )}
            {!resuming && step === 3 && (
              <TaxonomyReviewStep
                kbId={kbId}
                entityId={entityId}
                onNext={() => setStep(4)}
                onBack={() => setStep(2)}
              />
            )}
            {!resuming && step === 4 && (
              <ActionReviewStep
                kbId={kbId}
                entityId={entityId}
                onNext={() => setStep(5)}
                onBack={() => setStep(3)}
              />
            )}
            {!resuming && step === 5 && (
              <ReviewRulesStep
                kbId={kbId}
                entityId={entityId}
                onNext={() => setStep(6)}
                onBack={() => setStep(4)}
              />
            )}
            {!resuming && step === 6 && (
              <PreviewStep
                kbId={kbId}
                entityId={entityId}
                onNext={() => setStep(7)}
                onBack={() => { setEvidence(null); setStep(5) }}
                onResult={setEvidence}
              />
            )}
            {!resuming && step === 7 && (
              <SubmitStep
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
