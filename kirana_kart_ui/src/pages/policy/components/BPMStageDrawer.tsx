/**
 * BPMStageDrawer — slide-in drawer showing:
 *  - Current status in plain English
 *  - Timeline of stage transitions (audit trail)
 *  - Gate results (simulation / shadow)
 *  - Pending approvals with Approve / Reject actions
 *  - Primary action button for the current stage
 */

import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import {
  X, CheckCircle2, XCircle, Clock, BarChart2, Layers,
  ThumbsUp, ThumbsDown, AlertTriangle, Pencil,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { bpmApi, type BPMInstance, type StageTransition, type GateResult, type BPMApproval } from '@/api/governance/bpm.api'
import { STAGE_LABEL } from '../PolicyBPMPage'

interface Props {
  instance: BPMInstance
  kbId: string
  canAdmin: boolean
  onClose: () => void
  onRefresh: () => void
}

type Tab = 'status' | 'timeline' | 'gates' | 'approvals'

export function BPMStageDrawer({ instance, kbId, canAdmin, onClose, onRefresh }: Props) {
  const navigate = useNavigate()
  const [tab, setTab] = useState<Tab>('status')
  const [approveNotes, setApproveNotes] = useState('')
  const [rejectNotes, setRejectNotes] = useState('')
  const [showApproveForm, setShowApproveForm] = useState(false)
  const [showRejectForm, setShowRejectForm] = useState(false)

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

  const approveMutation = useMutation({
    mutationFn: (approvalId: number) => bpmApi.approveRequest(approvalId, approveNotes),
    onSuccess: () => { onRefresh(); refetchApprovals() },
  })

  const rejectMutation = useMutation({
    mutationFn: (approvalId: number) => bpmApi.rejectRequest(approvalId, rejectNotes),
    onSuccess: () => { onRefresh(); refetchApprovals() },
  })

  const pendingApproval = approvals.find((a: BPMApproval) => a.status === 'pending')

  return (
    <>
      {/* Scrim */}
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />

      {/* Drawer */}
      <div className="fixed right-0 top-0 bottom-0 z-50 w-full max-w-lg bg-surface-card border-l border-surface-border shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-border">
          <div>
            <p className="text-xs text-muted font-mono">{instance.entity_id}</p>
            <h2 className="text-base font-semibold text-foreground">
              {STAGE_LABEL[instance.current_stage] ?? instance.current_stage}
            </h2>
          </div>
          <button onClick={onClose} className="text-muted hover:text-foreground transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-surface-border px-2">
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

                  {/* Approve form */}
                  {showApproveForm ? (
                    <div className="space-y-3">
                      <textarea
                        value={approveNotes}
                        onChange={(e) => setApproveNotes(e.target.value)}
                        placeholder="Add approval notes (optional)..."
                        rows={3}
                        className={cn(
                          'w-full px-3 py-2 rounded-lg border text-sm resize-none',
                          'bg-surface-card border-surface-border text-foreground',
                          'placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-brand-500',
                        )}
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={() => setShowApproveForm(false)}
                          className="flex-1 py-2 text-sm border border-surface-border rounded-lg text-foreground hover:bg-surface transition-colors"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => approveMutation.mutate(pendingApproval.id)}
                          disabled={approveMutation.isPending}
                          className="flex-1 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 font-medium transition-colors"
                        >
                          {approveMutation.isPending ? 'Approving...' : 'Confirm Approval'}
                        </button>
                      </div>
                    </div>
                  ) : showRejectForm ? (
                    <div className="space-y-3">
                      <textarea
                        value={rejectNotes}
                        onChange={(e) => setRejectNotes(e.target.value)}
                        placeholder="Reason for rejection..."
                        rows={3}
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
                          disabled={rejectMutation.isPending}
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
                        className="flex-1 flex items-center justify-center gap-2 py-2.5 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 font-medium transition-colors"
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

function StatusTab({
  instance,
  pendingApproval,
  onEditRules,
}: {
  instance: BPMInstance
  pendingApproval?: BPMApproval
  onEditRules: () => void
}) {
  const stage = instance.current_stage
  const isActive = stage === 'ACTIVE'

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
        <p className="text-xs text-muted">Started {new Date(instance.started_at).toLocaleDateString()}</p>
        {instance.completed_at && (
          <p className="text-xs text-muted">Completed {new Date(instance.completed_at).toLocaleDateString()}</p>
        )}
      </div>

      {/* Rule edit CTA */}
      {stage === 'RULE_EDIT' && (
        <button
          onClick={onEditRules}
          className="w-full flex items-center justify-center gap-2 py-2.5 text-sm bg-brand-600 text-white rounded-xl font-medium hover:bg-brand-700 transition-colors"
        >
          <Pencil className="w-4 h-4" />
          Review &amp; Edit Rules
        </button>
      )}

      {/* Pending approval callout */}
      {pendingApproval && (
        <div className="flex items-center gap-2 text-sm text-amber-600 bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-700 rounded-lg px-3 py-2">
          <Clock className="w-4 h-4 shrink-0" />
          Waiting for approval by a governance admin
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
            <div className="flex-1 pb-4">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-foreground">
                  {STAGE_LABEL[t.to_stage] ?? t.to_stage}
                </p>
                <p className="text-xs text-muted">
                  {new Date(t.transitioned_at).toLocaleString()}
                </p>
              </div>
              {t.actor_name && (
                <p className="text-xs text-muted mt-0.5">by {t.actor_name}</p>
              )}
              {t.notes && (
                <p className="text-xs text-foreground/70 mt-1 italic">"{t.notes}"</p>
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
    simulation: 'Impact Preview',
    shadow:     'Background Test',
    diff_review: 'Change Review',
  }

  return (
    <div className="space-y-3">
      {gates.map((g) => (
        <div key={g.id} className={cn(
          'rounded-xl border p-4',
          g.passed
            ? 'border-green-200 dark:border-green-700 bg-green-50 dark:bg-green-900/10'
            : 'border-red-200 dark:border-red-700 bg-red-50 dark:bg-red-900/10',
        )}>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <BarChart2 className="w-4 h-4 text-muted" />
              <p className="text-sm font-semibold text-foreground">
                {GATE_LABEL[g.gate_type] ?? g.gate_type}
              </p>
            </div>
            <span className={cn(
              'text-xs px-2 py-0.5 rounded-full font-medium',
              g.passed ? 'text-green-600 bg-green-100 dark:bg-green-900/30' : 'text-red-600 bg-red-100 dark:bg-red-900/30',
            )}>
              {g.passed ? 'Passed' : 'Failed'}
            </span>
          </div>

          {/* Metrics */}
          <div className="space-y-1">
            {Object.entries(g.metrics as Record<string, unknown>).map(([key, val]) => (
              <div key={key} className="flex justify-between text-xs">
                <span className="text-muted capitalize">{key.replace(/_/g, ' ')}</span>
                <span className="text-foreground font-medium font-mono">
                  {typeof val === 'number' && val < 1 && val > 0
                    ? `${(val * 100).toFixed(1)}%`
                    : String(val)}
                </span>
              </div>
            ))}
          </div>

          <p className="text-xs text-muted mt-2">
            {new Date(g.ran_at).toLocaleString()}
          </p>
        </div>
      ))}
    </div>
  )
}
