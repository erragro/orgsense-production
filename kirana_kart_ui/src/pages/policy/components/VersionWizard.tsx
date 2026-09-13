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
  Rocket, CloudUpload, Pencil, Trash2, Plus, Save, Check, XCircle,
  ChevronRight, Tag, Zap,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { governanceClient as apiClient } from '@/api/clients'
import {
  bpmApi,
  type BPMInstance,
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

const uploadDocument = (kbId: string, file: File) => {
  const form = new FormData()
  form.append('file', file)
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

const STEPS = [
  { n: 1, label: 'Upload' },
  { n: 2, label: 'AI Analysis' },
  { n: 3, label: 'Taxonomy' },
  { n: 4, label: 'Actions' },
  { n: 5, label: 'Rules' },
  { n: 6, label: 'Preview' },
  { n: 7, label: 'Publish' },
]

function StepIndicator({ current }: { current: Step }) {
  return (
    <div className="flex items-center justify-center gap-0 mb-8">
      {STEPS.map((s, i) => (
        <div key={s.n} className="flex items-center">
          <div className="flex flex-col items-center gap-1">
            <div className={cn(
              'w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold border-2 transition-all',
              s.n < current
                ? 'bg-green-500 border-green-500 text-white'
                : s.n === current
                  ? 'bg-brand-600 border-brand-600 text-white'
                  : 'bg-surface border-surface-border text-muted',
            )}>
              {s.n < current ? <CheckCircle2 className="w-3.5 h-3.5" /> : s.n}
            </div>
            <span className={cn(
              'text-[10px] whitespace-nowrap',
              s.n === current ? 'text-brand-600 font-medium' : 'text-muted',
            )}>
              {s.label}
            </span>
          </div>
          {i < STEPS.length - 1 && (
            <div className={cn(
              'w-8 h-0.5 mb-5 mx-0.5 transition-colors',
              s.n < current ? 'bg-green-400' : 'bg-surface-border',
            )} />
          )}
        </div>
      ))}
    </div>
  )
}

// ============================================================
// Shared input style
// ============================================================

const inp = 'w-full px-2.5 py-1.5 rounded-lg border border-surface-border bg-surface text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-brand-500'

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
  const [dragOver, setDragOver] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const uploadMutation = useMutation({
    mutationFn: (f: File) => uploadDocument(kbId, f),
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
        <h2 className="text-lg font-semibold text-foreground">Upload your SOP document</h2>
        <p className="text-sm text-muted mt-1">
          The AI will read your document and extract issue types and actions in stages — each stage is reviewable before the next begins.
        </p>
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
            <p className="text-xs text-muted">{(file.size / 1024).toFixed(1)} KB</p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <CloudUpload className="w-10 h-10 text-muted" />
            <div>
              <p className="text-sm font-medium text-foreground">Drag & drop your SOP document here</p>
              <p className="text-xs text-muted mt-1">or click to browse files</p>
            </div>
            <p className="text-xs text-subtle">PDF · Word · Markdown · CSV</p>
          </div>
        )}
      </div>

      {file?.name.endsWith('.csv') && (
        <div className="flex items-start gap-2 bg-blue-50 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-700 rounded-lg p-3 text-sm text-blue-700 dark:text-blue-300">
          <FileType className="w-4 h-4 shrink-0 mt-0.5" />
          <span>CSV detected — rules will be imported directly without AI analysis.</span>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 dark:bg-red-900/10 border border-red-200 rounded-lg p-3">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      <div className="flex justify-between items-center">
        <p className="text-xs text-muted">Maximum file size: 20 MB</p>
        <button
          disabled={!file || uploadMutation.isPending}
          onClick={() => file && uploadMutation.mutate(file)}
          className="flex items-center gap-2 px-5 py-2.5 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-40 transition-colors"
        >
          {uploadMutation.isPending ? (
            <><Loader2 className="w-4 h-4 animate-spin" /> Uploading...</>
          ) : (
            <><Upload className="w-4 h-4" /> Upload & Continue</>
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
  const [progress, setProgress] = useState(0)
  const [findings, setFindings] = useState<string[]>([])
  const [error, setError] = useState('')

  const extractMut = useMutation({
    mutationFn: () => bpmApi.extractTaxonomy(kbId, entityId),
    onMutate: () => {
      setStatus('running'); setProgress(0); setFindings([])
      let p = 0
      const interval = setInterval(() => {
        p += Math.random() * 10
        if (p >= 88) { clearInterval(interval); p = 88 }
        setProgress(Math.min(p, 88))
      }, 400)
      return { interval }
    },
    onSuccess: (res, _, context) => {
      clearInterval((context as { interval: ReturnType<typeof setInterval> }).interval)
      setProgress(100); setStatus('done')
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
    onError: (e: Error, _, context) => {
      clearInterval((context as { interval: ReturnType<typeof setInterval> }).interval)
      setStatus('error'); setError(e.message ?? 'Analysis failed. Please try again.')
    },
  })

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">AI Analysis — Stage 1</h2>
        <p className="text-sm text-muted mt-1">
          The AI reads your SOP and identifies all issue types and their hierarchy.
        </p>
      </div>

      <div className="bg-surface-card border border-surface-border rounded-xl p-5">
        <div className="flex items-center gap-3 mb-4">
          <FileText className="w-5 h-5 text-muted shrink-0" />
          <span className="text-sm font-medium text-foreground truncate">{filename}</span>
        </div>

        {status === 'idle' && (
          <p className="text-sm text-muted text-center py-4">
            Click below to start extracting the issue taxonomy from your document.
          </p>
        )}

        {(status === 'running' || status === 'done') && (
          <div className="space-y-3">
            <div className="flex justify-between text-xs text-muted mb-1">
              <span>{status === 'done' ? 'Extraction complete' : 'Analyzing document...'}</span>
              <span>{Math.round(progress)}%</span>
            </div>
            <div className="h-2 bg-surface rounded-full overflow-hidden">
              <div
                className="h-full bg-brand-500 rounded-full transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
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
              <><Loader2 className="w-4 h-4 animate-spin" /> Extracting taxonomy...</>
            ) : (
              <><Sparkles className="w-4 h-4" /> {status === 'error' ? 'Retry' : 'Extract Issue Taxonomy'}</>
            )}
          </button>
        ) : (
          <button
            onClick={() => onNext(0)}
            className="flex items-center gap-2 px-5 py-2.5 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 transition-colors"
          >
            Review Taxonomy <ArrowRight className="w-4 h-4" />
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
  return <span className="text-xs px-1.5 py-0.5 rounded-full bg-surface text-muted border border-surface-border">Existing</span>
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
            <label className="text-xs text-muted mb-0.5 block">Label</label>
            <input className={inp} value={label} onChange={e => setLabel(e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-muted mb-0.5 block">Description</label>
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
          {proposal.level > 0 && <ChevronRight className="w-3 h-3 text-muted shrink-0" />}
          <Tag className="w-3.5 h-3.5 text-muted shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-sm font-medium text-foreground">{proposal.label}</span>
              <span className="text-xs font-mono text-muted">{proposal.issue_code}</span>
              {typeBadge(proposal.proposal_type)}
              {statusBadge(proposal.status)}
              {proposal.extraction_confidence != null && (
                <span className="text-xs text-muted">
                  {Math.round(proposal.extraction_confidence * 100)}% confidence
                </span>
              )}
            </div>
            {proposal.description && (
              <p className="text-xs text-muted mt-0.5 truncate">{proposal.description}</p>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {proposal.status !== 'rejected' && proposal.status !== 'accepted' && proposal.status !== 'edited' && (
              <button
                onClick={accept}
                disabled={reviewMut.isPending}
                className="p-1.5 rounded-lg text-muted hover:text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 transition-colors"
                title="Accept"
              >
                <Check className="w-3.5 h-3.5" />
              </button>
            )}
            {(proposal.status === 'accepted' || proposal.status === 'edited') && (
              <button
                onClick={reject}
                disabled={reviewMut.isPending}
                className="p-1.5 rounded-lg text-muted hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/10 transition-colors"
                title="Reject"
              >
                <XCircle className="w-3.5 h-3.5" />
              </button>
            )}
            {proposal.status === 'rejected' && (
              <button
                onClick={accept}
                disabled={reviewMut.isPending}
                className="p-1.5 rounded-lg text-muted hover:text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 transition-colors"
                title="Restore"
              >
                <Check className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              onClick={() => setEditing(true)}
              className="p-1.5 rounded-lg text-muted hover:text-brand-500 hover:bg-surface transition-colors"
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
          <h2 className="text-lg font-semibold text-foreground">Review Issue Taxonomy</h2>
          <p className="text-sm text-muted mt-1">
            These issue categories were extracted from your SOP. Accept, edit, or reject each one.
            Accepted categories form the foundation of your rules.
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
        <div className="flex items-center gap-3 text-xs text-muted">
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
        <div className="text-center py-8 text-sm text-muted">
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
          disabled={accepted === 0}
          className="flex items-center gap-2 px-5 py-2.5 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-40 transition-colors"
        >
          Extract Actions <ArrowRight className="w-4 h-4" />
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
            <label className="text-xs text-muted mb-0.5 block">Action name *</label>
            <input className={inp} value={actionName} onChange={e => setActionName(e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-muted mb-0.5 block">Exact action (what the agent should do)</label>
            <textarea
              className={cn(inp, 'min-h-[60px] resize-y')}
              value={exactAction}
              onChange={e => setExactAction(e.target.value)}
              placeholder="e.g. Issue full refund of order amount + ₹100 goodwill credit"
            />
          </div>
          <div>
            <label className="text-xs text-muted mb-0.5 block">Description</label>
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
          <Zap className="w-4 h-4 text-muted shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-sm font-medium text-foreground">{action.action_name}</span>
              <span className="text-xs font-mono text-muted">{action.action_code_id}</span>
              {typeBadge(action.proposal_type)}
              {statusBadge(action.status)}
            </div>
            {action.exact_action && (
              <p className="text-xs text-muted mt-1">{action.exact_action}</p>
            )}
            {action.parent_issue_codes.length > 0 && (
              <div className="flex items-center gap-1 flex-wrap mt-1">
                <span className="text-xs text-muted">Applies to:</span>
                {action.parent_issue_codes.slice(0, 3).map(c => (
                  <span key={c} className="text-xs px-1.5 py-0.5 bg-surface border border-surface-border rounded text-muted">{c}</span>
                ))}
                {action.parent_issue_codes.length > 3 && (
                  <span className="text-xs text-muted">+{action.parent_issue_codes.length - 3} more</span>
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
                className="p-1.5 rounded-lg text-muted hover:text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 transition-colors" title="Accept">
                <Check className="w-3.5 h-3.5" />
              </button>
            )}
            {(action.status === 'accepted' || action.status === 'edited') && (
              <button onClick={reject} disabled={reviewMut.isPending}
                className="p-1.5 rounded-lg text-muted hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/10 transition-colors" title="Reject">
                <XCircle className="w-3.5 h-3.5" />
              </button>
            )}
            {action.status === 'rejected' && (
              <button onClick={accept} disabled={reviewMut.isPending}
                className="p-1.5 rounded-lg text-muted hover:text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 transition-colors" title="Restore">
                <Check className="w-3.5 h-3.5" />
              </button>
            )}
            <button onClick={() => setEditing(true)}
              className="p-1.5 rounded-lg text-muted hover:text-brand-500 hover:bg-surface transition-colors" title="Edit">
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
        <h2 className="text-lg font-semibold text-foreground">Review Actions — Stage 2</h2>
        <p className="text-sm text-muted mt-1">
          The AI extracts every unique action for all issue permutations from your SOP. These actions become your Action Registry — the building blocks of all rules.
        </p>
      </div>

      {extractStatus === 'idle' && (
        <div className="bg-surface-card border border-surface-border rounded-xl p-5 text-center space-y-3">
          <Zap className="w-8 h-8 text-muted mx-auto" />
          <p className="text-sm text-muted">Ready to extract actions using the accepted taxonomy.</p>
          <button
            onClick={() => extractMut.mutate()}
            className="flex items-center gap-2 px-5 py-2.5 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 mx-auto transition-colors"
          >
            <Sparkles className="w-4 h-4" /> Extract Actions
          </button>
        </div>
      )}

      {extractStatus === 'running' && (
        <div className="bg-surface-card border border-surface-border rounded-xl p-5 text-center space-y-3">
          <Loader2 className="w-8 h-8 text-brand-500 mx-auto animate-spin" />
          <p className="text-sm text-muted">Extracting actions for all issue permutations...</p>
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
            <div className="flex items-center gap-3 text-xs text-muted">
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
          disabled={accepted === 0}
          className="flex items-center gap-2 px-5 py-2.5 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-40 transition-colors"
        >
          Generate Rules <ArrowRight className="w-4 h-4" />
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
            <label className="text-xs text-muted mb-0.5 block">Issue type (L1) *</label>
            <input className={inp} value={draft.issue_type_l1}
              onChange={e => setDraft(d => ({ ...d, issue_type_l1: e.target.value }))}
              placeholder="e.g. FOOD_SAFETY" />
          </div>
          <div>
            <label className="text-xs text-muted mb-0.5 block">Sub-type (L2)</label>
            <input className={inp} value={draft.issue_type_l2}
              onChange={e => setDraft(d => ({ ...d, issue_type_l2: e.target.value }))}
              placeholder="e.g. FOREIGN_OBJECT" />
          </div>
        </div>
        <div>
          <label className="text-xs text-muted mb-0.5 block">Action to take *</label>
          <input className={inp} value={draft.action_name}
            onChange={e => setDraft(d => ({ ...d, action_name: e.target.value }))}
            placeholder="e.g. Issue full refund + ₹100 compensation" />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="text-xs text-muted mb-0.5 block">Priority</label>
            <input className={inp} type="number" min={1} max={999} value={draft.priority}
              onChange={e => setDraft(d => ({ ...d, priority: parseInt(e.target.value) || 50 }))} />
          </div>
          <div>
            <label className="text-xs text-muted mb-0.5 block">Min order (₹)</label>
            <input className={inp} type="number" value={draft.min_order_value}
              onChange={e => setDraft(d => ({ ...d, min_order_value: e.target.value }))}
              placeholder="Any" />
          </div>
          <div>
            <label className="text-xs text-muted mb-0.5 block">Max order (₹)</label>
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
            <span className="text-xs font-mono text-muted">{rule.rule_id}</span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-blue-50 dark:bg-blue-900/20 text-blue-600 font-medium">
              {rule.issue_type_l1}{rule.issue_type_l2 ? ` › ${rule.issue_type_l2}` : ''}
            </span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-surface text-muted border border-surface-border">
              Priority {rule.priority}
            </span>
            {rule.deterministic && (
              <span className="text-xs text-green-600 bg-green-50 dark:bg-green-900/20 px-2 py-0.5 rounded-full">Auto</span>
            )}
          </div>
          <p className="text-sm font-medium text-foreground mt-1.5">{rule.action_name}</p>
          {(rule.min_order_value != null || rule.max_order_value != null) && (
            <p className="text-xs text-muted mt-0.5">
              Order value:{' '}
              {rule.min_order_value != null ? `≥ ₹${rule.min_order_value}` : ''}
              {rule.min_order_value != null && rule.max_order_value != null ? ' · ' : ''}
              {rule.max_order_value != null ? `≤ ₹${rule.max_order_value}` : ''}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button onClick={() => setEditing(true)}
            className="p-1.5 rounded-lg text-muted hover:text-brand-500 hover:bg-surface transition-colors" title="Edit rule">
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => delMut.mutate()}
            disabled={delMut.isPending}
            className="p-1.5 rounded-lg text-muted hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/10 transition-colors disabled:opacity-40"
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
        className="w-full flex items-center justify-center gap-2 py-3 border-2 border-dashed border-surface-border rounded-xl text-sm text-muted hover:border-brand-400 hover:text-brand-500 transition-colors"
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
          <label className="text-xs text-muted mb-0.5 block">Issue type (L1) *</label>
          <input className={inp} value={draft.issue_type_l1}
            onChange={e => setDraft(d => ({ ...d, issue_type_l1: e.target.value }))}
            placeholder="e.g. FOOD_SAFETY" />
        </div>
        <div>
          <label className="text-xs text-muted mb-0.5 block">Sub-type (L2)</label>
          <input className={inp} value={draft.issue_type_l2}
            onChange={e => setDraft(d => ({ ...d, issue_type_l2: e.target.value }))}
            placeholder="e.g. FOREIGN_OBJECT" />
        </div>
      </div>
      <div>
        <label className="text-xs text-muted mb-0.5 block">Action to take *</label>
        <input className={inp} value={draft.action_name}
          onChange={e => setDraft(d => ({ ...d, action_name: e.target.value }))}
          placeholder="e.g. Issue full refund + ₹100 compensation" />
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div>
          <label className="text-xs text-muted mb-0.5 block">Priority</label>
          <input className={inp} type="number" min={1} max={999} value={draft.priority}
            onChange={e => setDraft(d => ({ ...d, priority: parseInt(e.target.value) || 50 }))} />
        </div>
        <div>
          <label className="text-xs text-muted mb-0.5 block">Min order (₹)</label>
          <input className={inp} type="number" value={draft.min_order_value}
            onChange={e => setDraft(d => ({ ...d, min_order_value: e.target.value }))}
            placeholder="Any" />
        </div>
        <div>
          <label className="text-xs text-muted mb-0.5 block">Max order (₹)</label>
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
        <h2 className="text-lg font-semibold text-foreground">Review Rules — Stage 3</h2>
        <p className="text-sm text-muted mt-1">
          Rules are generated deterministically from the accepted taxonomy × actions. Edit, remove, or add rules as needed.
        </p>
      </div>

      {genStatus === 'running' && (
        <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted">
          <Loader2 className="w-5 h-5 animate-spin text-brand-500" />
          Generating rules from taxonomy × action registry...
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
            <div className="text-center py-6 text-sm text-muted">
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
            <p className="text-xs text-muted text-center">
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
          Preview <ArrowRight className="w-4 h-4" />
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
  } | null
}

function PreviewStep({
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
  const [simStatus, setSimStatus] = useState<SimStatus>('idle')
  const [metrics, setMetrics] = useState<Record<string, string> | null>(null)
  const [notice, setNotice] = useState('')

  const runSimMutation = useMutation({
    mutationFn: () =>
      apiClient.post<SimResponse>(`/bpm/kb/${kbId}/simulate`, { entity_id: entityId }),
    onMutate: () => { setSimStatus('running'); setNotice(''); setMetrics(null) },
    onSuccess: (res) => {
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
      setNotice('The preview request failed. Check the server logs and try again.')
    },
  })

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Preview</h2>
        <p className="text-sm text-muted mt-1">
          Run a quick preview to see how these rules compare against recent tickets.
        </p>
      </div>

      <div className={cn(
        'rounded-xl border p-5',
        simStatus === 'passed'
          ? 'border-green-200 dark:border-green-700 bg-green-50 dark:bg-green-900/10'
          : simStatus === 'failed'
            ? 'border-red-200 dark:border-red-700 bg-red-50 dark:bg-red-900/10'
            : simStatus === 'unavailable' || simStatus === 'error'
              ? 'border-amber-200 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/10'
              : 'border-surface-border bg-surface-card',
      )}>
        <div className="flex items-center gap-3 mb-4">
          <BarChart2 className="w-5 h-5 text-muted shrink-0" />
          <p className="text-sm font-semibold text-foreground">Preview Results</p>
          {simStatus === 'passed' && (
            <span className="ml-auto text-xs px-2 py-0.5 rounded-full bg-green-100 dark:bg-green-900/30 text-green-600 font-medium">Passed</span>
          )}
          {simStatus === 'failed' && (
            <span className="ml-auto text-xs px-2 py-0.5 rounded-full bg-red-100 dark:bg-red-900/30 text-red-600 font-medium">Review needed</span>
          )}
          {(simStatus === 'unavailable' || simStatus === 'error') && (
            <span className="ml-auto text-xs px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-500 font-medium">Not available</span>
          )}
        </div>

        {simStatus === 'idle' && (
          <p className="text-sm text-muted text-center py-4">
            Run the preview to compare this version against the current active policy.
          </p>
        )}
        {simStatus === 'running' && (
          <div className="flex flex-col items-center gap-3 py-4">
            <Loader2 className="w-6 h-6 animate-spin text-brand-500" />
            <p className="text-sm text-muted">Replaying the sample tickets against both versions...</p>
          </div>
        )}
        {(simStatus === 'unavailable' || simStatus === 'error') && (
          <div className="flex items-start gap-2.5 py-1">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="text-sm text-foreground">{notice}</p>
              <p className="text-xs text-muted">
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
                <span className="text-muted">{k}</span>
                <span className="text-foreground font-medium font-mono">{v}</span>
              </div>
            ))}
            {simStatus === 'failed' && (
              <p className="text-xs text-red-600 mt-3 pt-2 border-t border-red-200 dark:border-red-700">
                More decisions change than the gate allows. Review the rules
                before publishing.
              </p>
            )}
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
                ? <>Looks good <ArrowRight className="w-4 h-4" /></>
                : <>Continue without preview <ArrowRight className="w-4 h-4" /></>
              }
            </button>
          )}
          {simStatus === 'idle' && (
            <button
              onClick={onNext}
              className="flex items-center gap-2 px-4 py-2 text-sm border border-surface-border rounded-lg text-foreground hover:bg-surface transition-colors"
            >
              Skip <ArrowRight className="w-4 h-4" />
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

function PublishStep({
  kbId,
  entityId,
  onCreated,
  onBack,
}: {
  kbId: string
  entityId: string
  onCreated: () => void
  onBack: () => void
}) {
  const qc = useQueryClient()
  const { data: rules = [] } = useQuery({
    queryKey: ['rules', kbId, entityId, 'wizard'],
    queryFn: () => fetchRules(kbId, entityId).then(r => r.data),
  })

  const { data: instances = [] } = useQuery({
    queryKey: ['bpm', 'instances', kbId, 'wizard'],
    queryFn: () => bpmApi.listInstances(kbId, { limit: 5 }).then(r => r.data),
    refetchInterval: 15_000,
  })

  const latestInstance = instances.find((i: BPMInstance) => i.entity_id === entityId)
  const shadowDone =
    latestInstance?.current_stage === 'PENDING_APPROVAL' ||
    latestInstance?.current_stage === 'ACTIVE'
  const shadowInProgress = latestInstance?.current_stage === 'SHADOW_GATE'

  const publishMutation = useMutation({
    mutationFn: () => publishVersion(kbId, entityId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bpm', 'instances', kbId] })
      onCreated()
    },
  })

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Ready to publish?</h2>
        <p className="text-sm text-muted mt-1">
          This will replace the current active policy for all new tickets.
        </p>
      </div>

      <div className="bg-surface-card border border-surface-border rounded-xl p-5 space-y-3">
        <div className="flex items-center gap-3 text-sm">
          <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />
          <span className="text-foreground">Issue taxonomy reviewed</span>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />
          <span className="text-foreground">Actions reviewed and confirmed</span>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />
          <span className="text-foreground">{rules.length} rules ready</span>
        </div>
        <div className="flex items-center gap-3 text-sm">
          {shadowDone ? (
            <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />
          ) : shadowInProgress ? (
            <Loader2 className="w-4 h-4 animate-spin text-blue-500 shrink-0" />
          ) : (
            <div className="w-4 h-4 rounded-full border-2 border-surface-border shrink-0" />
          )}
          <span className={cn('text-foreground', shadowInProgress && 'text-blue-600')}>
            {shadowDone
              ? 'Background test complete'
              : shadowInProgress
                ? 'Background test running...'
                : 'Background test pending'}
          </span>
        </div>
      </div>

      {shadowInProgress && (
        <div className="flex items-center gap-2 text-sm text-blue-600 bg-blue-50 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-700 rounded-lg px-3 py-2">
          <Loader2 className="w-4 h-4 shrink-0 animate-spin" />
          Background test is collecting data. You can publish now or wait for it to finish.
        </div>
      )}

      {publishMutation.isError && (
        <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 dark:bg-red-900/10 border border-red-200 rounded-lg p-3">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          Publish failed. Please try again.
        </div>
      )}

      <div className="flex justify-between">
        <button
          onClick={onBack}
          className="flex items-center gap-2 px-4 py-2 text-sm border border-surface-border rounded-lg text-foreground hover:bg-surface transition-colors"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <button
          onClick={() => publishMutation.mutate()}
          disabled={publishMutation.isPending}
          className="flex items-center gap-2 px-6 py-2.5 bg-brand-600 text-white rounded-lg text-sm font-semibold hover:bg-brand-700 disabled:opacity-40 transition-colors"
        >
          {publishMutation.isPending ? (
            <><Loader2 className="w-4 h-4 animate-spin" /> Publishing...</>
          ) : (
            <><Rocket className="w-4 h-4" /> Publish Now</>
          )}
        </button>
      </div>
    </div>
  )
}

// ============================================================
// Main Wizard
// ============================================================

export function VersionWizard({ kbId, onClose, onCreated }: Props) {
  const [step, setStep] = useState<Step>(1)
  const [entityId, setEntityId] = useState('')
  const [filename, setFilename] = useState('')

  const handleUploadDone = (eid: string, fname: string) => {
    setEntityId(eid); setFilename(fname); setStep(2)
  }

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-surface-card border border-surface-border rounded-2xl shadow-2xl w-full max-w-2xl max-h-[92vh] overflow-y-auto">
          <div className="flex items-center justify-between px-6 py-4 border-b border-surface-border">
            <div>
              <p className="text-xs text-muted font-mono">{kbId}</p>
              <h1 className="text-base font-semibold text-foreground">New Policy Version</h1>
            </div>
            <button onClick={onClose} className="text-muted hover:text-foreground transition-colors">
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
                onBack={() => setStep(5)}
              />
            )}
            {step === 7 && (
              <PublishStep
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
