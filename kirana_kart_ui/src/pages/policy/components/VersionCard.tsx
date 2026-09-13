/**
 * VersionCard — single policy version row on the BPM board.
 * Shows plain-English status + primary action button.
 */

import { Clock, User, ChevronRight, RotateCcw, CheckCircle2, Loader2, XCircle } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { BPMInstance } from '@/api/governance/bpm.api'
import { STAGE_LABEL } from '../PolicyBPMPage'

interface Props {
  instance: BPMInstance
  kbId: string
  canAdmin: boolean
  onOpen: () => void
}

const STAGE_COLOR: Record<string, string> = {
  ACTIVE:               'text-green-600 bg-green-50 dark:bg-green-900/20',
  PENDING_APPROVAL:     'text-amber-600 bg-amber-50 dark:bg-amber-900/20',
  SHADOW_GATE:          'text-blue-600 bg-blue-50 dark:bg-blue-900/20',
  SIMULATION_GATE:      'text-blue-600 bg-blue-50 dark:bg-blue-900/20',
  RULE_EDIT:            'text-purple-600 bg-purple-50 dark:bg-purple-900/20',
  AI_COMPILE_QUEUED:    'text-blue-600 bg-blue-50 dark:bg-blue-900/20',
  AI_COMPILE_FAILED:    'text-red-600 bg-red-50 dark:bg-red-900/20',
  SIMULATION_FAILED:    'text-red-600 bg-red-50 dark:bg-red-900/20',
  SHADOW_DIVERGENCE_HIGH: 'text-orange-600 bg-orange-50 dark:bg-orange-900/20',
  REJECTED:             'text-red-600 bg-red-50 dark:bg-red-900/20',
  ROLLBACK_PENDING:     'text-amber-600 bg-amber-50 dark:bg-amber-900/20',
  RETIRED:              'text-muted bg-surface',
  DRAFT:                'text-muted bg-surface',
}

const STAGE_ICON: Record<string, typeof Loader2> = {
  ACTIVE:            CheckCircle2,
  PENDING_APPROVAL:  Clock,
  SHADOW_GATE:       Loader2,
  SIMULATION_GATE:   Loader2,
  AI_COMPILE_QUEUED: Loader2,
  AI_COMPILE_FAILED: XCircle,
  SIMULATION_FAILED: XCircle,
  SHADOW_DIVERGENCE_HIGH: XCircle,
  REJECTED:          XCircle,
  ROLLBACK_PENDING:  RotateCcw,
}

const STEP_MAP: Record<string, string> = {
  DRAFT:                  'Step 1 of 5 — Starting',
  AI_COMPILE_QUEUED:      'Step 2 of 5 — AI analyzing',
  AI_COMPILE_FAILED:      'Step 2 of 5 — Analysis failed',
  RULE_EDIT:              'Step 3 of 5 — Reviewing rules',
  SIMULATION_GATE:        'Step 4 of 5 — Running impact preview',
  SIMULATION_FAILED:      'Step 4 of 5 — Impact preview failed',
  SHADOW_GATE:            'Step 4 of 5 — Background test running',
  SHADOW_DIVERGENCE_HIGH: 'Step 4 of 5 — Background test issues',
  PENDING_APPROVAL:       'Step 5 of 5 — Waiting for approval',
  REJECTED:               'Rejected — needs revision',
  ACTIVE:                 'Published and live',
  ROLLBACK_PENDING:       'Restore request pending',
  RETIRED:                'Retired',
}

function formatAge(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins  = Math.floor(diff / 60_000)
  const hours = Math.floor(mins / 60)
  const days  = Math.floor(hours / 24)
  if (days > 0) return `${days}d ago`
  if (hours > 0) return `${hours}h ago`
  return `${mins}m ago`
}

export function VersionCard({ instance, onOpen }: Props) {
  const { current_stage: stage } = instance
  const colorCls  = STAGE_COLOR[stage] ?? 'text-muted bg-surface'
  const Icon      = STAGE_ICON[stage] ?? Clock
  const isSpinner = ['AI_COMPILE_QUEUED', 'SIMULATION_GATE', 'SHADOW_GATE'].includes(stage)

  const primaryAction =
    stage === 'RULE_EDIT' ? 'Continue reviewing'
    : stage === 'PENDING_APPROVAL' ? 'View approval request'
    : stage === 'SIMULATION_FAILED' ? 'View failure details'
    : stage === 'AI_COMPILE_FAILED' ? 'Retry or edit'
    : stage === 'SHADOW_DIVERGENCE_HIGH' ? 'Review changes'
    : 'View details'

  return (
    <button
      onClick={onOpen}
      className="w-full flex items-center gap-4 px-5 py-4 hover:bg-surface/50 transition-colors text-left group"
    >
      {/* Stage icon */}
      <div className={cn('w-9 h-9 rounded-lg flex items-center justify-center shrink-0', colorCls)}>
        <Icon className={cn('w-4 h-4', isSpinner && 'animate-spin')} />
      </div>

      {/* Main content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground font-mono">
            {instance.entity_id}
          </span>
          <span className={cn('text-xs px-2 py-0.5 rounded-full font-medium', colorCls)}>
            {STAGE_LABEL[stage] ?? stage}
          </span>
        </div>
        <p className="text-xs text-muted mt-0.5">{STEP_MAP[stage] ?? stage}</p>
        <div className="flex items-center gap-3 mt-1 text-xs text-subtle">
          {instance.created_by_name && (
            <span className="flex items-center gap-1">
              <User className="w-3 h-3" />
              {instance.created_by_name}
            </span>
          )}
          <span className="flex items-center gap-1">
            <Clock className="w-3 h-3" />
            {formatAge(instance.started_at)}
          </span>
          {instance.pending_approvals ? (
            <span className="text-amber-600 font-medium">
              {instance.pending_approvals} approval{instance.pending_approvals > 1 ? 's' : ''} pending
            </span>
          ) : null}
        </div>
      </div>

      {/* Primary action */}
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-xs text-brand-600 font-medium opacity-0 group-hover:opacity-100 transition-opacity">
          {primaryAction}
        </span>
        <ChevronRight className="w-4 h-4 text-muted group-hover:text-foreground transition-colors" />
      </div>
    </button>
  )
}
