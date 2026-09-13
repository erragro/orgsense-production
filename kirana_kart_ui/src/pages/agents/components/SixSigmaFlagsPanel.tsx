/**
 * SixSigmaFlagsPanel — shows the 6 LLM Six Sigma checks + 2 ML checks
 * from a QA evaluation, with dismiss buttons for flags scoring below 0.6.
 *
 * Admin users (policy.admin) can dismiss flags with a reason.
 * Dismissed flags are loaded from the server and shown in a "Dismissed" state.
 */

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  BookOpen, Brain, CheckCircle2, XCircle, AlertCircle,
  ChevronDown, ChevronUp, X,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { qaApi } from '@/api/governance/qa.api'
import type { QAParameterResult, MLCheckResult, DismissedFlag } from '@/types/qa.types'
import { FlagDismissModal } from './FlagDismissModal'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatPct(score: number) {
  return `${Math.round(score * 100)}%`
}

function scoreBg(score: number) {
  if (score >= 0.80) return 'bg-emerald-500'
  if (score >= 0.60) return 'bg-amber-500'
  return 'bg-red-500'
}

function scoreTextColor(score: number) {
  if (score >= 0.80) return 'text-emerald-400'
  if (score >= 0.60) return 'text-amber-400'
  return 'text-red-400'
}

function statusBadge(score: number, dismissed: boolean) {
  if (dismissed) return { label: 'Dismissed', cls: 'bg-surface-border text-muted border-surface-border' }
  if (score >= 0.80) return { label: 'Pass', cls: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' }
  if (score >= 0.60) return { label: 'Warn', cls: 'bg-amber-500/15 text-amber-400 border-amber-500/30' }
  return { label: 'Flag', cls: 'bg-red-500/15 text-red-400 border-red-500/30' }
}

// ─── LLM Parameter Card ───────────────────────────────────────────────────────

function LLMParamCard({
  param,
  evaluationId,
  canAdmin,
  dismissed,
}: {
  param: QAParameterResult
  evaluationId: number | null
  canAdmin: boolean
  dismissed: DismissedFlag | undefined
}) {
  const [open, setOpen] = useState(false)
  const [showDismiss, setShowDismiss] = useState(false)
  const badge = statusBadge(param.score, !!dismissed)
  const isFlagged = param.score < 0.6 && !dismissed

  return (
    <>
      <div className={cn(
        'rounded-lg border bg-surface-card overflow-hidden',
        isFlagged
          ? 'border-red-500/30'
          : dismissed
            ? 'border-surface-border opacity-60'
            : 'border-surface-border',
      )}>
        <button
          className="w-full flex items-start gap-3 p-3 text-left hover:bg-surface/50 transition-colors"
          onClick={() => setOpen(v => !v)}
        >
          {/* Score bar */}
          <div className="flex flex-col items-center gap-1 shrink-0 pt-0.5">
            <span className={cn('text-sm font-bold tabular-nums', dismissed ? 'text-muted' : scoreTextColor(param.score))}>
              {formatPct(param.score)}
            </span>
            <div className="w-1.5 h-12 rounded-full bg-surface-border overflow-hidden">
              <div
                className={cn('w-full rounded-full transition-all duration-700', dismissed ? 'bg-surface-border' : scoreBg(param.score))}
                style={{ height: `${param.score * 100}%` }}
              />
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-sm font-medium text-foreground truncate">{param.name}</span>
              <div className="flex items-center gap-1.5 shrink-0">
                <span className={cn('text-[10px] font-semibold px-1.5 py-0.5 rounded border', badge.cls)}>
                  {badge.label}
                </span>
                <span className="text-[9px] text-muted bg-surface-border px-1.5 py-0.5 rounded">Six Sigma</span>
                {open ? <ChevronUp className="w-3.5 h-3.5 text-muted" /> : <ChevronDown className="w-3.5 h-3.5 text-muted" />}
              </div>
            </div>
            <p className="text-xs text-muted mt-1 line-clamp-2 leading-relaxed">{param.finding}</p>
          </div>
        </button>

        {open && (
          <div className="px-4 pb-3 pt-0 border-t border-surface-border bg-surface/20 space-y-2">
            <div>
              <span className="text-[10px] font-semibold text-muted uppercase tracking-wide">Finding</span>
              <p className="text-xs text-foreground mt-0.5 leading-relaxed">{param.finding}</p>
            </div>
            <div>
              <span className="text-[10px] font-semibold text-muted uppercase tracking-wide">Recommendation</span>
              <p className={cn(
                'text-xs mt-0.5 leading-relaxed',
                param.recommendation === 'No action required' ? 'text-emerald-400' : 'text-amber-300',
              )}>
                {param.recommendation}
              </p>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-subtle">Weight: {(param.weight * 100).toFixed(0)}%</span>
              {dismissed && (
                <span className="text-[10px] text-muted italic">
                  Dismissed — {dismissed.override_reason}
                </span>
              )}
            </div>

            {/* Dismiss button — only for flagged items */}
            {isFlagged && canAdmin && evaluationId != null && (
              <button
                onClick={e => { e.stopPropagation(); setShowDismiss(true) }}
                className="flex items-center gap-1.5 text-xs text-amber-400 hover:text-amber-300 border border-amber-500/30 hover:border-amber-400/50 rounded-lg px-3 py-1.5 transition-colors w-full justify-center mt-1"
              >
                <X className="w-3 h-3" />
                Dismiss — it's expected
              </button>
            )}
          </div>
        )}
      </div>

      {showDismiss && evaluationId != null && (
        <FlagDismissModal
          evaluationId={evaluationId}
          parameterName={param.name}
          originalScore={param.score}
          onClose={() => setShowDismiss(false)}
        />
      )}
    </>
  )
}

// ─── ML Check Card ────────────────────────────────────────────────────────────

function MLCheckCard({
  check,
  evaluationId,
  canAdmin,
  dismissed,
}: {
  check: MLCheckResult
  evaluationId: number | null
  canAdmin: boolean
  dismissed: DismissedFlag | undefined
}) {
  const [open, setOpen] = useState(false)
  const [showDismiss, setShowDismiss] = useState(false)
  const badge = statusBadge(check.score, !!dismissed)
  const isFlagged = check.score < 0.6 && !dismissed

  return (
    <>
      <div className={cn(
        'rounded-lg border bg-surface-card overflow-hidden',
        isFlagged ? 'border-red-500/30' : dismissed ? 'border-surface-border opacity-60' : 'border-surface-border',
      )}>
        <button
          className="w-full flex items-start gap-3 p-3 text-left hover:bg-surface/50 transition-colors"
          onClick={() => setOpen(v => !v)}
        >
          {/* Score bar */}
          <div className="flex flex-col items-center gap-1 shrink-0 pt-0.5">
            <span className={cn('text-sm font-bold tabular-nums', dismissed ? 'text-muted' : scoreTextColor(check.score))}>
              {formatPct(check.score)}
            </span>
            <div className="w-1.5 h-12 rounded-full bg-surface-border overflow-hidden">
              <div
                className={cn('w-full rounded-full transition-all duration-700', dismissed ? 'bg-surface-border' : scoreBg(check.score))}
                style={{ height: `${check.score * 100}%` }}
              />
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-1.5">
                <Brain className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                <span className="text-sm font-medium text-foreground truncate">{check.name}</span>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <span className={cn('text-[10px] font-semibold px-1.5 py-0.5 rounded border', badge.cls)}>
                  {badge.label}
                </span>
                <span className="text-[9px] text-blue-400 bg-blue-500/10 px-1.5 py-0.5 rounded">ML</span>
                {open ? <ChevronUp className="w-3.5 h-3.5 text-muted" /> : <ChevronDown className="w-3.5 h-3.5 text-muted" />}
              </div>
            </div>
            <p className="text-xs text-muted mt-1 line-clamp-2 leading-relaxed">{check.finding}</p>
          </div>
        </button>

        {open && (
          <div className="px-4 pb-3 pt-0 border-t border-surface-border bg-surface/20 space-y-2">
            <div>
              <span className="text-[10px] font-semibold text-muted uppercase tracking-wide">Finding</span>
              <p className="text-xs text-foreground mt-0.5 leading-relaxed">{check.finding}</p>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-subtle">Weight: {(check.weight * 100).toFixed(0)}% · Source: ML heuristic</span>
              {dismissed && (
                <span className="text-[10px] text-muted italic">Dismissed — {dismissed.override_reason}</span>
              )}
            </div>
            {isFlagged && canAdmin && evaluationId != null && (
              <button
                onClick={e => { e.stopPropagation(); setShowDismiss(true) }}
                className="flex items-center gap-1.5 text-xs text-amber-400 hover:text-amber-300 border border-amber-500/30 hover:border-amber-400/50 rounded-lg px-3 py-1.5 transition-colors w-full justify-center mt-1"
              >
                <X className="w-3 h-3" />
                Dismiss — it's expected
              </button>
            )}
          </div>
        )}
      </div>

      {showDismiss && evaluationId != null && (
        <FlagDismissModal
          evaluationId={evaluationId}
          parameterName={check.name}
          originalScore={check.score}
          onClose={() => setShowDismiss(false)}
        />
      )}
    </>
  )
}

// ─── Main Panel ───────────────────────────────────────────────────────────────

interface Props {
  parameters: QAParameterResult[]
  mlChecks: MLCheckResult[]
  evaluationId: number | null
  canAdmin: boolean
  streaming: boolean
}

export function SixSigmaFlagsPanel({ parameters, mlChecks, evaluationId, canAdmin, streaming }: Props) {
  const { data: flagsData = [] } = useQuery({
    queryKey: ['qa-flags', evaluationId],
    queryFn: () => qaApi.getFlags(evaluationId!).then(r => r.data),
    enabled: !!evaluationId,
  })

  const dismissedMap = Object.fromEntries(flagsData.map(f => [f.parameter_name, f]))

  const flagCount = [...parameters, ...mlChecks].filter(
    p => p.score < 0.6 && !dismissedMap[p.name],
  ).length

  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <BookOpen className="w-4 h-4 text-brand-400" />
        <span className="text-sm font-semibold text-foreground">AI Quality Evaluation</span>
        <span className="text-xs text-muted">
          ({parameters.length}/6 Six Sigma{mlChecks.length > 0 ? ` · ${mlChecks.length}/2 ML` : ''}
          {streaming ? ' — evaluating…' : ''})
        </span>
        {flagCount > 0 && (
          <div className="ml-auto flex items-center gap-1.5 text-xs text-red-400">
            <AlertCircle className="w-3.5 h-3.5" />
            {flagCount} flag{flagCount !== 1 ? 's' : ''} need{flagCount === 1 ? 's' : ''} review
            {canAdmin && <span className="text-muted">— click a flag to dismiss</span>}
          </div>
        )}
        {flagCount === 0 && parameters.length > 0 && !streaming && (
          <div className="ml-auto flex items-center gap-1.5 text-xs text-emerald-400">
            <CheckCircle2 className="w-3.5 h-3.5" />
            All checks passed
          </div>
        )}
      </div>

      {/* Six Sigma LLM checks */}
      {parameters.length > 0 && (
        <div className="mb-3">
          <p className="text-[10px] font-semibold text-muted uppercase tracking-wide mb-2">
            Six Sigma Evaluations (LLM)
          </p>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
            {parameters.map((p, i) => (
              <LLMParamCard
                key={i}
                param={p}
                evaluationId={evaluationId}
                canAdmin={canAdmin}
                dismissed={dismissedMap[p.name]}
              />
            ))}
            {/* Skeleton placeholders */}
            {streaming && Array.from({ length: 6 - parameters.length }).map((_, i) => (
              <div key={`sk-${i}`} className="rounded-lg border border-surface-border bg-surface-card p-3 animate-pulse">
                <div className="h-3 w-36 bg-surface-border rounded mb-2" />
                <div className="h-2 w-full bg-surface-border rounded" />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ML checks */}
      {mlChecks.length > 0 && (
        <div>
          <p className="text-[10px] font-semibold text-muted uppercase tracking-wide mb-2">
            ML Checks
          </p>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
            {mlChecks.map((c, i) => (
              <MLCheckCard
                key={i}
                check={c}
                evaluationId={evaluationId}
                canAdmin={canAdmin}
                dismissed={dismissedMap[c.name]}
              />
            ))}
          </div>
        </div>
      )}

      {/* Dismissed flags summary */}
      {flagsData.length > 0 && (
        <div className="mt-3 flex items-center gap-2 text-[10px] text-muted border-t border-surface-border pt-2">
          <XCircle className="w-3 h-3 text-muted shrink-0" />
          {flagsData.length} flag{flagsData.length !== 1 ? 's' : ''} dismissed by governance admin
        </div>
      )}
    </div>
  )
}
