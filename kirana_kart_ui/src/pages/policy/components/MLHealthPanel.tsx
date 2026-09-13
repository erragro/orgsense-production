/**
 * MLHealthPanel — Admin-only panel showing AI learning status.
 *
 * Shows plain-English status for all 3 ML models:
 *  - Rule Extractor (Model A)
 *  - Rule Conflict Detector (Model B)
 *  - Version Gate Predictor (Model C)
 *
 * No model names, no file paths, no hyperparameters — just accuracy + status.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw, Loader2, CheckCircle2, Brain, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/cn'
import { governanceClient } from '@/api/clients'

interface ModelHealth {
  model_key: string
  display_name: string
  status: 'active' | 'learning' | 'no_data'
  accuracy: number | null
  f1_score?: number | null
  sample_count: number
  samples_needed?: number
  trained_at?: string
}

const fetchMLHealth = (kbId: string) =>
  governanceClient.get<ModelHealth[]>(`/bpm/ml/health`, { params: { kb_id: kbId } })
    .then((r) => r.data)

const forceRetrain = (kbId: string) =>
  governanceClient.post(`/bpm/ml/retrain`, null, { params: { kb_id: kbId } })
    .then((r) => r.data)

function ModelCard({ m }: { m: ModelHealth }) {
  const pct = m.accuracy != null ? Math.round(m.accuracy * 100) : null

  return (
    <div className={cn(
      'rounded-xl border p-4',
      m.status === 'active'
        ? 'border-green-200 dark:border-green-700 bg-green-50 dark:bg-green-900/10'
        : m.status === 'learning'
          ? 'border-blue-200 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/10'
          : 'border-surface-border bg-surface-card',
    )}>
      <div className="flex items-center gap-2 mb-3">
        <Brain className={cn('w-4 h-4 shrink-0',
          m.status === 'active' ? 'text-green-600' : m.status === 'learning' ? 'text-blue-600' : 'text-muted',
        )} />
        <p className="text-sm font-semibold text-foreground">{m.display_name}</p>
        <span className={cn(
          'ml-auto text-xs px-2 py-0.5 rounded-full font-medium',
          m.status === 'active'
            ? 'bg-green-100 dark:bg-green-900/30 text-green-600'
            : m.status === 'learning'
              ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600'
              : 'bg-surface text-muted border border-surface-border',
        )}>
          {m.status === 'active' ? 'Active' : m.status === 'learning' ? 'Learning' : 'No data yet'}
        </span>
      </div>

      {pct != null ? (
        <div className="space-y-2">
          <div className="flex justify-between text-xs text-muted">
            <span>Accuracy</span>
            <span className="font-mono font-medium text-foreground">{pct}%</span>
          </div>
          <div className="h-2 bg-surface rounded-full overflow-hidden">
            <div
              className={cn('h-full rounded-full transition-all', pct >= 85 ? 'bg-green-500' : pct >= 70 ? 'bg-amber-500' : 'bg-red-500')}
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="text-xs text-muted">
            Learned from {m.sample_count.toLocaleString()} examples
            {m.trained_at && (
              <> · Updated {new Date(m.trained_at).toLocaleDateString()}</>
            )}
          </p>
        </div>
      ) : m.status === 'learning' ? (
        <div className="space-y-1.5">
          <div className="h-2 bg-surface rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-400 rounded-full"
              style={{ width: `${Math.min(100, (m.sample_count / (m.samples_needed ?? 50 + m.sample_count)) * 100)}%` }}
            />
          </div>
          <p className="text-xs text-blue-600">
            {m.sample_count} of {(m.samples_needed ?? 0) + m.sample_count} examples collected
          </p>
          {m.samples_needed && m.samples_needed > 0 && (
            <p className="text-xs text-muted">
              Need {m.samples_needed} more to start predicting
            </p>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted">No data collected yet. Will start learning as versions are reviewed.</p>
      )}
    </div>
  )
}

interface Props {
  kbId: string
  canAdmin: boolean
}

export function MLHealthPanel({ kbId, canAdmin }: Props) {
  const qc = useQueryClient()

  const { data: models = [], isLoading, error } = useQuery({
    queryKey: ['ml', 'health', kbId],
    queryFn: () => fetchMLHealth(kbId),
    refetchInterval: 60_000,
  })

  const retrain = useMutation({
    mutationFn: () => forceRetrain(kbId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ml', 'health', kbId] }),
  })

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground">AI Learning Status</h3>
          <p className="text-xs text-muted mt-0.5">Models improve automatically as more versions are reviewed.</p>
        </div>
        {canAdmin && (
          <button
            onClick={() => retrain.mutate()}
            disabled={retrain.isPending}
            className="flex items-center gap-1.5 text-xs text-muted hover:text-foreground border border-surface-border rounded-lg px-3 py-1.5 hover:bg-surface transition-colors disabled:opacity-50"
          >
            {retrain.isPending
              ? <><Loader2 className="w-3 h-3 animate-spin" /> Retraining...</>
              : <><RefreshCw className="w-3 h-3" /> Force Retrain</>
            }
          </button>
        )}
      </div>

      {isLoading && (
        <div className="flex justify-center py-6">
          <Loader2 className="w-5 h-5 animate-spin text-brand-500" />
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 dark:bg-red-900/10 border border-red-200 rounded-lg px-3 py-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          Could not load model status.
        </div>
      )}

      {retrain.isSuccess && (
        <div className="flex items-center gap-2 text-sm text-green-600 bg-green-50 dark:bg-green-900/10 border border-green-200 rounded-lg px-3 py-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          Retraining complete.
        </div>
      )}

      {models.length > 0 && (
        <div className="grid grid-cols-1 gap-3">
          {models.map((m) => (
            <ModelCard key={m.model_key} m={m} />
          ))}
        </div>
      )}
    </div>
  )
}
