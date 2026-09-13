// src/pages/cardinal/tabs/PhaseAnalysisTab.tsx
// ==============================================
// Phase Analysis — per-phase health cards for all Cardinal phases and LLM stages,
// plus a bar chart comparing error rates across all phases.

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card'
import { BarMetricChart } from '@/components/charts/BarMetricChart'
import { Skeleton }       from '@/components/ui/Skeleton'
import { EmptyState }     from '@/components/common/EmptyState'
import { Badge }          from '@/components/ui/Badge'
import { cn }             from '@/lib/cn'
import { cardinalApi }    from '@/api/governance/cardinal.api'
import type { PhaseStats } from '@/types/cardinal.types'
import { Layers, ChevronDown, ChevronUp, CheckCircle, XCircle } from 'lucide-react'

function PhaseCard({ phase }: { phase: PhaseStats }) {
  const [expanded, setExpanded] = useState(false)

  const successRate = phase.processed > 0
    ? ((phase.passed / phase.processed) * 100).toFixed(1)
    : '—'

  const statusColor =
    phase.error_rate_pct > 10 ? 'red' :
    phase.error_rate_pct > 3  ? 'amber' : 'green'

  const statusBg =
    statusColor === 'red'   ? 'border-l-red-500' :
    statusColor === 'amber' ? 'border-l-amber-500' : 'border-l-green-500'

  const isLlmStage   = phase.type === 'llm_stage'
  const phaseLabel   = isLlmStage ? `LLM Stage ${phase.stage.replace('llm_', '')}` : `Phase ${phase.phase}`

  return (
    <Card className={cn('border-l-4', statusBg)}>
      <CardContent className="p-4">
        {/* Header row */}
        <div className="flex items-start justify-between gap-2 mb-3">
          <div>
            <p className="text-xs text-subtle uppercase tracking-wider font-medium">{phaseLabel}</p>
            <p className="font-semibold text-foreground mt-0.5">{phase.name}</p>
          </div>
          <Badge
            variant={statusColor === 'green' ? 'green' : statusColor === 'amber' ? 'amber' : 'red'}
            className="text-xs shrink-0"
          >
            {phase.error_rate_pct.toFixed(1)}% err
          </Badge>
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
          <div className="flex items-center gap-1.5">
            <span className="text-subtle text-xs">Processed</span>
            <span className="font-medium text-foreground ml-auto">{phase.processed.toLocaleString()}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-subtle text-xs">Success rate</span>
            <span className="font-medium text-foreground ml-auto">{successRate}%</span>
          </div>
          <div className="flex items-center gap-1">
            <CheckCircle className="w-3 h-3 text-green-400" />
            <span className="text-subtle text-xs">Passed</span>
            <span className="font-medium text-green-400 ml-auto">{phase.passed.toLocaleString()}</span>
          </div>
          <div className="flex items-center gap-1">
            <XCircle className="w-3 h-3 text-red-400" />
            <span className="text-subtle text-xs">Failed</span>
            <span className="font-medium text-red-400 ml-auto">{phase.failed.toLocaleString()}</span>
          </div>
          <div className="col-span-2">
            <span className="text-subtle text-xs">Avg latency</span>
            <span className="font-medium text-foreground ml-2">
              {phase.avg_latency_ms >= 1000
                ? `${(phase.avg_latency_ms / 1000).toFixed(2)}s`
                : `${Math.round(phase.avg_latency_ms)}ms`}
            </span>
          </div>
        </div>

        {/* Expandable top errors */}
        {phase.top_errors.length > 0 && (
          <div className="mt-3 border-t border-surface-border pt-2">
            <button
              onClick={() => setExpanded((v) => !v)}
              className="flex items-center gap-1 text-xs text-muted hover:text-foreground transition-colors"
            >
              {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              Top errors ({phase.top_errors.length})
            </button>
            {expanded && (
              <ul className="mt-2 space-y-1">
                {phase.top_errors.map((e, i) => (
                  <li key={i} className="flex justify-between gap-2 text-xs">
                    <span className="text-muted truncate" title={e.message}>{e.message}</span>
                    <span className="shrink-0 text-red-400 font-medium">{e.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export function PhaseAnalysisTab() {
  const { data: phases, isLoading, isError } = useQuery({
    queryKey: ['cardinal', 'phase-stats'],
    queryFn:  () => cardinalApi.phaseStats().then((r) => r.data),
    refetchInterval: 60_000,
  })

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-48" />)}
        </div>
        <Skeleton className="h-56" />
      </div>
    )
  }

  if (isError || !phases) {
    return <EmptyState icon={<Layers className="w-8 h-8 text-subtle" />} title="Could not load phase data" description="Check that the governance API is running." />
  }

  if (phases.length === 0) {
    return <EmptyState icon={<Layers className="w-8 h-8 text-subtle" />} title="No phase data yet" description="Phase statistics will appear once tickets have been processed through Cardinal." />
  }

  // Bar chart data — error rate per phase
  const barData = phases.map((p) => ({
    name:      p.name,
    errorRate: p.error_rate_pct,
  }))

  const cardinalPhases = phases.filter((p) => p.type === 'cardinal_phase')
  const llmStages      = phases.filter((p) => p.type === 'llm_stage')

  return (
    <div className="space-y-6">
      {/* ── Cardinal phases ─────────────────────────────── */}
      {cardinalPhases.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold text-subtle uppercase tracking-wider mb-3">
            Cardinal Pipeline — 5 Phases
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
            {cardinalPhases.map((p) => <PhaseCard key={p.stage} phase={p} />)}
          </div>
        </div>
      )}

      {/* ── LLM Worker stages ───────────────────────────── */}
      {llmStages.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold text-subtle uppercase tracking-wider mb-3">
            LLM Worker — 4 Stages (Celery)
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {llmStages.map((p) => <PhaseCard key={p.stage} phase={p} />)}
          </div>
        </div>
      )}

      {/* ── Error rate comparison chart ──────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Error Rate Comparison — All Phases</CardTitle>
        </CardHeader>
        <CardContent>
          <BarMetricChart
            data={barData}
            bars={[{ key: 'errorRate', name: 'Error Rate (%)', color: '#ef4444' }]}
            xKey="name"
            height={220}
          />
        </CardContent>
      </Card>
    </div>
  )
}
