/**
 * MLHealthPanel — shows the status of the 3 local ML models.
 * Admin-only. Displays accuracy, sample count, and learning progress.
 * Sourced from GET /bpm/ml/health.
 */

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Brain, ChevronDown, ChevronUp, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/cn'
import { bpmApi, type MLModelHealth } from '@/api/governance/bpm.api'
import { toast } from '@/stores/toast.store'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function AccuracyBar({ value }: { value: number | null }) {
  if (value === null) return null
  const pct = Math.round(value * 100)
  const color = pct >= 80 ? 'bg-emerald-500' : pct >= 60 ? 'bg-amber-500' : 'bg-red-500'
  return (
    <div className="w-full h-1.5 bg-surface-border rounded-full overflow-hidden mt-1">
      <div className={cn('h-full rounded-full transition-all duration-700', color)} style={{ width: `${pct}%` }} />
    </div>
  )
}

function StatusDot({ status }: { status: MLModelHealth['status'] }) {
  return (
    <span className={cn(
      'inline-block w-2 h-2 rounded-full shrink-0',
      status === 'active' ? 'bg-emerald-400' :
      status === 'learning' ? 'bg-amber-400 animate-pulse' :
      'bg-surface-border',
    )} />
  )
}

function ModelCard({ model }: { model: MLModelHealth }) {
  const isActive = model.status === 'active'
  const isLearning = model.status === 'learning'

  return (
    <div className="rounded-lg border border-surface-border bg-surface-card p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <StatusDot status={model.status} />
          <span className="text-xs font-medium text-foreground">{model.display_name}</span>
        </div>
        <span className={cn(
          'text-[10px] font-semibold px-1.5 py-0.5 rounded border',
          isActive ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' :
          isLearning ? 'bg-amber-500/10 text-amber-400 border-amber-500/30' :
          'bg-surface-border text-muted border-surface-border',
        )}>
          {isActive ? 'Active' : isLearning ? 'Learning' : 'No data'}
        </span>
      </div>

      {isActive && model.accuracy !== null && (
        <div>
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-muted">Accuracy</span>
            <span className="font-semibold text-foreground">{Math.round(model.accuracy * 100)}%</span>
          </div>
          <AccuracyBar value={model.accuracy} />
        </div>
      )}

      <div className="flex items-center justify-between text-[10px] text-muted">
        <span>
          {isActive
            ? `Trained on ${model.sample_count.toLocaleString()} examples`
            : isLearning
            ? `${model.sample_count} / ${(model.sample_count + (model.samples_needed ?? 0)).toLocaleString()} samples collected`
            : 'No training data yet'}
        </span>
        {isLearning && model.samples_needed !== undefined && model.samples_needed > 0 && (
          <span className="text-amber-400">{model.samples_needed} more needed</span>
        )}
      </div>

      {isLearning && model.samples_needed !== undefined && (
        <div className="w-full h-1.5 bg-surface-border rounded-full overflow-hidden">
          <div
            className="h-full rounded-full bg-amber-500/60 transition-all duration-700"
            style={{
              width: `${Math.min(100, (model.sample_count / (model.sample_count + model.samples_needed)) * 100)}%`,
            }}
          />
        </div>
      )}

      {isActive && model.trained_at && (
        <p className="text-[10px] text-subtle">
          Updated {new Date(model.trained_at).toLocaleDateString()}
        </p>
      )}
    </div>
  )
}

// ─── Panel ────────────────────────────────────────────────────────────────────

interface Props {
  kbId?: string
  canAdmin: boolean
}

export function MLHealthPanel({ kbId = 'default', canAdmin }: Props) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)

  const { data: models = [], isLoading } = useQuery({
    queryKey: ['ml-health', kbId],
    queryFn: () => bpmApi.getMLHealth(kbId).then((r) => r.data),
    enabled: open,
    staleTime: 60_000,
  })

  const retrain = useMutation({
    mutationFn: () => bpmApi.forceRetrain(kbId),
    onSuccess: () => {
      toast.success('Retraining triggered', 'Models will be updated in a few minutes')
      void qc.invalidateQueries({ queryKey: ['ml-health', kbId] })
    },
    onError: () => toast.error('Retraining failed'),
  })

  const activeCount = models.filter((m) => m.status === 'active').length

  return (
    <div className="border border-surface-border rounded-lg overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-4 py-3 bg-surface-card hover:bg-surface/50 transition-colors"
        onClick={() => setOpen((v) => !v)}
      >
        <div className="flex items-center gap-2">
          <Brain className="w-4 h-4 text-blue-400" />
          <span className="text-sm font-semibold text-foreground">AI Learning Status</span>
          <span className="text-xs text-muted">(admin)</span>
          {!open && !isLoading && models.length > 0 && (
            <span className="text-xs text-muted">
              — {activeCount}/{models.length} models active
            </span>
          )}
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-muted" /> : <ChevronDown className="w-4 h-4 text-muted" />}
      </button>

      {open && (
        <div className="px-4 pb-4 pt-3 bg-surface/10 space-y-3">
          {isLoading ? (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="rounded-lg border border-surface-border bg-surface-card p-3 animate-pulse">
                  <div className="h-3 w-32 bg-surface-border rounded mb-2" />
                  <div className="h-2 w-full bg-surface-border rounded" />
                </div>
              ))}
            </div>
          ) : models.length === 0 ? (
            <p className="text-xs text-muted py-2">Could not load model health data.</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {models.map((m) => <ModelCard key={m.model_key} model={m} />)}
            </div>
          )}

          {canAdmin && (
            <div className="flex items-center justify-between pt-1 border-t border-surface-border">
              <p className="text-[10px] text-subtle">
                Models retrain automatically as more data is collected.
              </p>
              <button
                onClick={() => retrain.mutate()}
                disabled={retrain.isPending}
                className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 border border-blue-500/30 hover:border-blue-400/50 rounded px-2.5 py-1 transition-colors disabled:opacity-50"
              >
                <RefreshCw className={cn('w-3 h-3', retrain.isPending && 'animate-spin')} />
                {retrain.isPending ? 'Retraining…' : 'Force Retrain'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
