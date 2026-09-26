/**
 * BPMStageDrawer — slide-in drawer showing:
 *  - Current status in plain English and the next step for this proposal
 *  - Timeline of stage transitions (audit trail)
 *  - Gate results (sample decision comparison)
 *  - The open approval request, with readiness evidence and Approve / Reject
 *
 * Approving a policy version activates it for new tickets. The server
 * enforces who may approve (policy admin on this KB, not the submitter) and
 * refuses until the version's runtime preparation has completed.
 */

import { useEffect, useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import {
  X, CheckCircle2, XCircle, Clock, BarChart2, Layers,
  ThumbsUp, ThumbsDown, AlertTriangle, Pencil, ArrowRight,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { apiErrorMessage } from '@/lib/api-error'
import { useAuthStore } from '@/stores/auth.store'
import { bpmApi, type BPMInstance, type StageTransition, type GateResult, type BPMApproval } from '@/api/governance/bpm.api'
import { EDITABLE_STAGES, STAGE_LABEL } from '../stages'

interface Props {
  instance: BPMInstance
  kbId: string
  canAdmin: boolean
  canEdit: boolean
  onResume: () => void
  onClose: () => void
  onRefresh: () => void
}

type Tab = 'status' | 'timeline' | 'gates' | 'approvals'

const PREPARATION_LABEL: Record<string, string> = {
  pending: 'Queued',
  in_progress: 'In progress',
  completed: 'Ready',
  failed: 'Failed',
}

export function BPMStageDrawer({ instance, kbId, canAdmin, canEdit, onResume, onClose, onRefresh }: Props) {
  const navigate = useNavigate()
  const { user } = useAuthStore()
  const [tab, setTab] = useState<Tab>(instance.current_stage === 'PENDING_APPROVAL' ? 'approvals' : 'status')
  const [approveNotes, setApproveNotes] = useState('')
  const [rejectNotes, setRejectNotes] = useState('')
  const [showApproveForm, setShowApproveForm] = useState(false)
  const [showRejectForm, setShowRejectForm] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const { data: trail = [] } = useQuery({
    queryKey: ['bpm', 'trail', instance.id],
    queryFn: () => bpmApi.getAuditTrail(kbId, instance.id).then((r) => r.data),
    enabled: tab === 'timeline',
  })

  const { data: gates = [] } = useQuery({
    queryKey: ['bpm', 'gates', instance.id],
    queryFn: () => bpmApi.getGateResults(kbId, instance.id).then((r) => r.data),
    enabled: tab === 'gates',
  })

  const { data: approvals = [], refetch: refetchApprovals } = useQuery({
    queryKey: ['bpm', 'approvals', instance.id],
    queryFn: () => bpmApi.getPendingApprovals(kbId, instance.id).then((r) => r.data),
  })

  const isKbVersion = instance.entity_type === 'kb_version'
  const readiness = useQuery({
    queryKey: ['bpm', 'readiness', kbId, instance.entity_id],
    queryFn: () => bpmApi.getReadiness(kbId, instance.entity_id).then((r) => r.data),
    enabled: isKbVersion && instance.current_stage === 'PENDING_APPROVAL',
    refetchInterval: (query) => query.state.data?.preparation_status === 'completed' ? false : 10_000,
  })

  const approveMutation = useMutation({
    mutationFn: (approvalId: number) => bpmApi.approveRequest(approvalId, approveNotes || undefined),
    onSuccess: () => { onRefresh(); refetchApprovals() },
  })

  const rejectMutation = useMutation({
    mutationFn: (approvalId: number) => bpmApi.rejectRequest(approvalId, rejectNotes),
    onSuccess: () => { onRefresh(); refetchApprovals() },
  })

  const retryPreparation = useMutation({
    mutationFn: () => bpmApi.submitForApproval(kbId, instance.entity_id),
    onSuccess: () => readiness.refetch(),
  })

  const pendingApproval = approvals.find((a: BPMApproval) => a.status === 'pending')
  const ownRequest = !!pendingApproval && pendingApproval.requested_by_id === user?.id
  const prepared = !isKbVersion || readiness.data?.preparation_status === 'completed'
  const decisionError = approveMutation.error ?? rejectMutation.error

  return (
    <>
      {/* Scrim */}
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />

      {/* Drawer */}
      <div role="dialog" aria-modal="true" aria-label="Policy proposal details"
        className="fixed right-0 top-0 bottom-0 z-50 w-full max-w-lg bg-surface-card border-l border-surface-border shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-border">
          <div className="min-w-0">
            <p className="text-xs text-muted font-mono truncate">{instance.entity_id}</p>
            <h2 className="text-base font-semibold text-foreground">
              {STAGE_LABEL[instance.current_stage] ?? instance.current_stage}
            </h2>
          </div>
          <button aria-label="Close details" onClick={onClose} className="text-muted hover:text-foreground transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-surface-border px-2 overflow-x-auto">
          {(['status', 'timeline', 'gates', 'approvals'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                'px-4 py-2.5 text-sm font-medium capitalize transition-colors relative',
                tab === t
                  ? 'text-brand-600 after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:bg-brand-500'
                  : 'text-muted hover:text-foreground',
              )}
            >
              {t}
              {t === 'approvals' && pendingApproval && (
                <span className="ml-1.5 inline-flex items-center justify-center w-4 h-4 text-xs bg-amber-100 dark:bg-amber-900/30 text-amber-600 rounded-full">
                  1
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {tab === 'status' && (
            <StatusTab
              instance={instance}
              pendingApproval={pendingApproval}
              canEdit={canEdit}
              onResume={onResume}
              onEditRules={() => {
                navigate(`/policy/rules?kb=${kbId}&version=${instance.entity_id}`)
                onClose()
              }}
            />
          )}

          {tab === 'timeline' && (
            <TimelineTab trail={trail} />
          )}

          {tab === 'gates' && (
            <GatesTab gates={gates} />
          )}

          {tab === 'approvals' && (
            <div className="space-y-4">
              {!pendingApproval && (
                <p className="text-sm text-muted text-center py-8">No pending approvals.</p>
              )}

              {pendingApproval && isKbVersion && readiness.data && (
                <section aria-label="Approval evidence" className="rounded-xl border border-surface-border p-4 text-sm space-y-2">
                  <p className="font-semibold text-foreground">What you are approving</p>
                  <Row label="Decisions" value={String(readiness.data.review.rules)} />
                  <Row label="Replaces" value={readiness.data.live_version ?? 'Nothing — this will be the first live version'} />
                  <Row label="Runtime preparation" value={PREPARATION_LABEL[readiness.data.preparation_status ?? ''] ?? 'Not started'} />
                  <Row label="Rules unchanged since submission" value={readiness.data.rules_unchanged_since_submission ? 'Yes' : 'No'} />
                  <Row label="Live comparison cases" value={readiness.data.live_comparison_cases ? String(readiness.data.live_comparison_cases) : 'None recorded'} />
                  <p className="text-xs text-muted pt-1">
                    The runtime serves one policy at a time: approving replaces the policy used for all new tickets.
                    See the Gates tab for the sample comparison and any justification recorded in the Timeline.
                  </p>
                  {readiness.data.preparation_status === 'failed' && canEdit && (
                    <button onClick={() => retryPreparation.mutate()} disabled={retryPreparation.isPending}
                      className="text-xs underline text-amber-700 dark:text-amber-400">
                      {retryPreparation.isPending ? 'Retrying…' : 'Retry runtime preparation'}
                    </button>
                  )}
                </section>
              )}

              {pendingApproval && !canAdmin && (
                <p className="text-sm text-muted">A policy administrator must decide this request.</p>
              )}

              {pendingApproval && canAdmin && (
                <div className="bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-700 rounded-xl p-4">
                  <div className="flex items-start gap-3 mb-4">
                    <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-semibold text-foreground">Approval required</p>
                      <p className="text-xs text-muted mt-0.5">
                        Requested by {pendingApproval.requested_by} ·{' '}
                        {new Date(pendingApproval.requested_at).toLocaleDateString()}
                      </p>
                    </div>
                  </div>

                  {ownRequest && (
                    <p className="text-xs text-amber-800 dark:text-amber-300 mb-3">
                      You submitted this request. Another policy administrator normally approves it; you can still reject (withdraw) it.
                    </p>
                  )}
                  {isKbVersion && !prepared && (
                    <p role="status" className="text-xs text-amber-800 dark:text-amber-300 mb-3">
                      Approval unlocks when runtime preparation is ready.
                    </p>
                  )}

                  {showApproveForm ? (
                    <div className="space-y-3">
                      <textarea
                        value={approveNotes}
                        onChange={(e) => setApproveNotes(e.target.value)}
                        placeholder="Add approval notes (optional)..."
                        aria-label="Approval notes"
                        rows={3}
                        maxLength={2000}
                        className={cn(
                          'w-full px-3 py-2 rounded-lg border text-sm resize-none',
                          'bg-surface-card border-surface-border text-foreground',
                          'placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-brand-500',
                        )}
                      />
                      {isKbVersion && (
                        <label className="flex items-start gap-2 text-xs text-foreground">
                          <input type="checkbox" className="mt-0.5" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
                          <span>I have reviewed the evidence and its limits, and approve replacing the live policy for new tickets.</span>
                        </label>
                      )}
                      <div className="flex gap-2">
                        <button
                          onClick={() => setShowApproveForm(false)}
                          className="flex-1 py-2 text-sm border border-surface-border rounded-lg text-foreground hover:bg-surface transition-colors"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => approveMutation.mutate(pendingApproval.id)}
                          disabled={approveMutation.isPending || !prepared || (isKbVersion && !acknowledged)}
                          className="flex-1 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 font-medium transition-colors"
                        >
                          {approveMutation.isPending ? 'Activating…' : isKbVersion ? 'Approve and activate' : 'Confirm Approval'}
                        </button>
                      </div>
                    </div>
                  ) : showRejectForm ? (
                    <div className="space-y-3">
                      <textarea
                        value={rejectNotes}
                        onChange={(e) => setRejectNotes(e.target.value)}
                        placeholder="Reason for rejection (required)..."
                        aria-label="Reason for rejection"
                        rows={3}
                        maxLength={2000}
                        className={cn(
                          'w-full px-3 py-2 rounded-lg border text-sm resize-none',
                          'bg-surface-card border-surface-border text-foreground',
                          'placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-brand-500',
                        )}
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={() => setShowRejectForm(false)}
                          className="flex-1 py-2 text-sm border border-surface-border rounded-lg text-foreground hover:bg-surface transition-colors"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => rejectMutation.mutate(pendingApproval.id)}
                          disabled={rejectMutation.isPending || !rejectNotes.trim()}
                          className="flex-1 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 font-medium transition-colors"
                        >
                          {rejectMutation.isPending ? 'Rejecting...' : 'Confirm Rejection'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <button
                        onClick={() => setShowApproveForm(true)}
                        disabled={ownRequest}
                        className="flex-1 flex items-center justify-center gap-2 py-2.5 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-40 font-medium transition-colors"
                      >
                        <ThumbsUp className="w-4 h-4" />
                        Approve
                      </button>
                      <button
                        onClick={() => setShowRejectForm(true)}
                        className="flex-1 flex items-center justify-center gap-2 py-2.5 text-sm border border-red-300 text-red-600 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 font-medium transition-colors"
                      >
                        <ThumbsDown className="w-4 h-4" />
                        Reject
                      </button>
                    </div>
                  )}

                  {decisionError && (
                    <p role="alert" className="text-xs text-red-600 mt-3">
                      {apiErrorMessage(decisionError, 'The decision could not be recorded. Nothing was changed.')}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  )
}

// ---- Sub-components ----

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted">{label}</span>
      <span className="text-foreground font-medium text-right break-all">{value}</span>
    </div>
  )
}

const NEXT_STEP: Record<string, string> = {
  DRAFT: 'Continue in the wizard to identify the customer problems in the uploaded SOP.',
  AI_COMPILE_QUEUED: 'Continue in the wizard to review the customer problems and responses.',
  AI_COMPILE_FAILED: 'The analysis failed. Continue in the wizard to retry it.',
  RULE_EDIT: 'Review the decisions, then run the sample comparison.',
  SIMULATION_FAILED: 'More sample decisions changed than the threshold allows. Revise the decisions, or justify the change when requesting approval.',
  SHADOW_GATE: 'Tested. Request approval from another policy administrator.',
  SHADOW_DIVERGENCE_HIGH: 'Review the live comparison differences and revise the decisions.',
  REJECTED: 'Rejected. Reopen it in the wizard to revise and test again.',
}

function StatusTab({
  instance,
  pendingApproval,
  canEdit,
  onResume,
  onEditRules,
}: {
  instance: BPMInstance
  pendingApproval?: BPMApproval
  canEdit: boolean
  onResume: () => void
  onEditRules: () => void
}) {
  const stage = instance.current_stage
  const isActive = stage === 'ACTIVE'
  const editable = instance.entity_type === 'kb_version' && EDITABLE_STAGES.has(stage)

  return (
    <div className="space-y-4">
      {/* Current status card */}
      <div className={cn(
        'rounded-xl p-4 border',
        isActive
          ? 'bg-green-50 dark:bg-green-900/10 border-green-200 dark:border-green-700'
          : 'bg-surface border-surface-border',
      )}>
        <p className="text-sm font-semibold text-foreground mb-1">
          {STAGE_LABEL[stage] ?? stage}
        </p>
        {NEXT_STEP[stage] && <p className="text-sm text-foreground/80 mb-2">{NEXT_STEP[stage]}</p>}
        <p className="text-xs text-muted">Started {new Date(instance.started_at).toLocaleDateString()}</p>
        {instance.completed_at && (
          <p className="text-xs text-muted">Completed {new Date(instance.completed_at).toLocaleDateString()}</p>
        )}
      </div>

      {editable && canEdit && (
        <button
          onClick={onResume}
          className="w-full flex items-center justify-center gap-2 py-2.5 text-sm bg-brand-600 text-white rounded-xl font-medium hover:bg-brand-700 transition-colors"
        >
          Continue in Policy Studio <ArrowRight className="w-4 h-4" />
        </button>
      )}

      {editable && canEdit && (
        <button
          onClick={onEditRules}
          className="w-full flex items-center justify-center gap-2 py-2.5 text-sm border border-surface-border text-foreground rounded-xl font-medium hover:bg-surface transition-colors"
        >
          <Pencil className="w-4 h-4" />
          Open in the advanced rule editor
        </button>
      )}

      {/* Pending approval callout */}
      {pendingApproval && (
        <div className="flex items-center gap-2 text-sm text-amber-600 bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-700 rounded-lg px-3 py-2">
          <Clock className="w-4 h-4 shrink-0" />
          Waiting for approval by a policy administrator
        </div>
      )}

      {/* ML predictions if any */}
      {instance.ml_predictions && Object.keys(instance.ml_predictions).length > 0 && (
        <div className="rounded-xl border border-surface-border p-4">
          <p className="text-xs font-semibold text-muted uppercase tracking-wide mb-3">AI Predictions</p>
          {Object.entries(instance.ml_predictions as Record<string, unknown>).map(([key, val]) => (
            <div key={key} className="flex justify-between text-sm py-1 border-b border-surface-border last:border-0">
              <span className="text-muted capitalize">{key.replace(/_/g, ' ')}</span>
              <span className="text-foreground font-medium">{String(val)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function TimelineTab({ trail }: { trail: StageTransition[] }) {
  if (!trail.length) {
    return <p className="text-sm text-muted text-center py-8">No history yet.</p>
  }

  return (
    <div className="relative">
      <div className="absolute left-4 top-2 bottom-2 w-0.5 bg-surface-border" />
      <div className="space-y-4">
        {trail.map((t) => (
          <div key={t.id} className="flex gap-4 relative">
            <div className="w-8 h-8 rounded-full border-2 border-surface-border bg-surface-card flex items-center justify-center shrink-0 z-10">
              {t.to_stage === 'ACTIVE' ? (
                <CheckCircle2 className="w-4 h-4 text-green-500" />
              ) : t.to_stage.includes('FAILED') || t.to_stage === 'REJECTED' ? (
                <XCircle className="w-4 h-4 text-red-500" />
              ) : (
                <Layers className="w-3.5 h-3.5 text-muted" />
              )}
            </div>
            <div className="flex-1 pb-4 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium text-foreground">
                  {STAGE_LABEL[t.to_stage] ?? t.to_stage}
                </p>
                <p className="text-xs text-muted shrink-0">
                  {new Date(t.transitioned_at).toLocaleString()}
                </p>
              </div>
              {t.actor_name && (
                <p className="text-xs text-muted mt-0.5">by {t.actor_name}</p>
              )}
              {t.notes && (
                <p className="text-xs text-foreground/70 mt-1 italic break-words">"{t.notes}"</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function GatesTab({ gates }: { gates: GateResult[] }) {
  if (!gates.length) {
    return <p className="text-sm text-muted text-center py-8">No gate results yet.</p>
  }

  const GATE_LABEL: Record<string, string> = {
    simulation: 'Sample decision comparison',
    shadow:     'Live comparison evidence',
    diff_review: 'Change Review',
  }

  return (
    <div className="space-y-3">
      {gates.map((g) => {
        const notApplicable = (g.metrics as { status?: string }).status === 'not_applicable'
        return (
          <div key={g.id} className={cn(
            'rounded-xl border p-4',
            notApplicable
              ? 'border-surface-border bg-surface'
              : g.passed
                ? 'border-green-200 dark:border-green-700 bg-green-50 dark:bg-green-900/10'
                : 'border-red-200 dark:border-red-700 bg-red-50 dark:bg-red-900/10',
          )}>
            <div className="flex items-center justify-between mb-3 gap-2">
              <div className="flex items-center gap-2">
                <BarChart2 className="w-4 h-4 text-muted" />
                <p className="text-sm font-semibold text-foreground">
                  {GATE_LABEL[g.gate_type] ?? g.gate_type}
                </p>
              </div>
              <span className={cn(
                'text-xs px-2 py-0.5 rounded-full font-medium',
                notApplicable ? 'text-muted bg-surface-card border border-surface-border'
                  : g.passed ? 'text-green-600 bg-green-100 dark:bg-green-900/30' : 'text-red-600 bg-red-100 dark:bg-red-900/30',
              )}>
                {notApplicable ? 'Not applicable: nothing live to compare' : g.passed ? 'Within configured threshold' : 'Threshold exceeded: review required'}
              </span>
            </div>

            {/* Metrics */}
            <div className="space-y-1">
              {Object.entries(g.metrics as Record<string, unknown>).filter(([key, val]) => key !== 'status' && (val == null || ['string', 'number', 'boolean'].includes(typeof val))).map(([key, val]) => (
                <div key={key} className="flex justify-between gap-4 text-xs">
                  <span className="text-muted capitalize">{key.replace(/_/g, ' ')}</span>
                  <span className="text-foreground font-medium font-mono text-right break-all">
                    {typeof val === 'number' && key.endsWith('rate')
                      ? `${(val * 100).toFixed(1)}%`
                      : String(val)}
                  </span>
                </div>
              ))}
              {Object.entries(g.metrics as Record<string, unknown>).filter(([, val]) => val !== null && typeof val === 'object').map(([key, val]) => (
                <details key={key} className="text-xs border-t border-surface-border pt-2 mt-2">
                  <summary className="cursor-pointer capitalize">View {key.replace(/_/g, ' ')}{Array.isArray(val) ? ` (${val.length} items)` : ' (structured evidence)'}</summary>
                  <pre className="whitespace-pre-wrap break-all mt-2 max-h-64 overflow-auto">{JSON.stringify(val, null, 2)}</pre>
                </details>
              ))}
            </div>

            <p className="text-xs text-muted mt-2">
              {new Date(g.ran_at).toLocaleString()}
            </p>
          </div>
        )
      })}
    </div>
  )
}
