// src/pages/cardinal/tabs/OverviewTab.tsx
// ==========================================
// Pipeline Overview — live dashboard with StatCards, volume trend,
// and source/channel distribution charts.

import { useQuery } from '@tanstack/react-query'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card'
import { StatCard }        from '@/components/charts/StatCard'
import { TrendLineChart }  from '@/components/charts/TrendLineChart'
import { PieDonutChart }   from '@/components/charts/PieDonutChart'
import { Skeleton }        from '@/components/ui/Skeleton'
import { EmptyState }      from '@/components/common/EmptyState'
import { cardinalApi }     from '@/api/governance/cardinal.api'
import { Activity, Inbox, Zap, GitMerge, Clock, AlertTriangle } from 'lucide-react'

export function OverviewTab() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['cardinal', 'overview'],
    queryFn:  () => cardinalApi.overview().then((r) => r.data),
    refetchInterval: 30_000,
  })

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-24" />)}
        </div>
        <Skeleton className="h-60" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Skeleton className="h-52" />
          <Skeleton className="h-52" />
        </div>
      </div>
    )
  }

  if (isError || !data) {
    return <EmptyState icon={<Activity className="w-8 h-8 text-subtle" />} title="Could not load overview" description="Check that the governance API is running." />
  }

  // Volume trend for TrendLineChart
  const trendData = data.volume_trend.map((pt) => ({
    date:  pt.date,
    count: pt.count,
  }))

  // Source distribution for PieDonutChart
  const sourceChartData = data.source_distribution.map((item) => ({
    name:  item.source ?? 'unknown',
    value: item.count,
  }))

  // Channel distribution for PieDonutChart
  const channelChartData = data.channel_distribution.map((item) => ({
    name:  item.channel ?? 'unknown',
    value: item.count,
  }))

  return (
    <div className="space-y-6">
      {/* ── Stat Cards ─────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <StatCard
          label="Today"
          value={data.totals.today.toLocaleString()}
          subtitle="tickets processed"
          icon={<Inbox className="w-4 h-4 text-brand-400" />}
          highlight="blue"
        />
        <StatCard
          label="Last 7 Days"
          value={data.totals.last_7d.toLocaleString()}
          subtitle="tickets"
          icon={<Activity className="w-4 h-4 text-blue-400" />}
        />
        <StatCard
          label="Auto-Resolution"
          value={`${data.rates.auto_resolution_pct.toFixed(1)}%`}
          subtitle="of completed tickets"
          icon={<Zap className="w-4 h-4 text-green-400" />}
          highlight={data.rates.auto_resolution_pct >= 70 ? 'green' : 'amber'}
        />
        <StatCard
          label="Dedup Rate"
          value={`${data.rates.dedup_pct.toFixed(1)}%`}
          subtitle="duplicate tickets caught"
          icon={<GitMerge className="w-4 h-4 text-purple-400" />}
        />
        <StatCard
          label="Avg Processing"
          value={
            data.avg_processing_ms >= 1000
              ? `${(data.avg_processing_ms / 1000).toFixed(1)}s`
              : `${Math.round(data.avg_processing_ms)}ms`
          }
          subtitle="end-to-end LLM chain"
          icon={<Clock className="w-4 h-4 text-amber-400" />}
        />
        <StatCard
          label="Phase Failures"
          value={`${data.rates.phase_failure_pct.toFixed(1)}%`}
          subtitle="of pipeline events"
          icon={<AlertTriangle className="w-4 h-4 text-red-400" />}
          highlight={data.rates.phase_failure_pct > 5 ? 'red' : 'green'}
        />
      </div>

      {/* ── Volume Trend ────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Ticket Volume — Last 14 Days</CardTitle>
        </CardHeader>
        <CardContent>
          {trendData.length === 0 ? (
            <EmptyState icon={<Activity className="w-8 h-8 text-subtle" />} title="No data yet" description="Ticket volume trend will appear here once tickets are processed." className="h-40" />
          ) : (
            <TrendLineChart
              data={trendData}
              lines={[{ key: 'count', name: 'Tickets', color: '#6366f1' }]}
              xKey="date"
              height={220}
            />
          )}
        </CardContent>
      </Card>

      {/* ── Source & Channel Distribution ───────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Ticket Source Breakdown</CardTitle>
          </CardHeader>
          <CardContent>
            {sourceChartData.length === 0 ? (
              <EmptyState icon={<Activity className="w-8 h-8 text-subtle" />} title="No data" description="Source distribution will appear here." className="h-36" />
            ) : (
              <PieDonutChart data={sourceChartData} height={200} innerRadius={50} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Channel Breakdown</CardTitle>
          </CardHeader>
          <CardContent>
            {channelChartData.length === 0 ? (
              <EmptyState icon={<Activity className="w-8 h-8 text-subtle" />} title="No data" description="Channel distribution will appear here." className="h-36" />
            ) : (
              <PieDonutChart data={channelChartData} height={200} innerRadius={50} />
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── All-time count footer ───────────────────────── */}
      <p className="text-xs text-subtle text-right">
        All-time total: <span className="font-medium text-foreground">{data.totals.all_time.toLocaleString()}</span> tickets · auto-refreshes every 30s
      </p>
    </div>
  )
}
