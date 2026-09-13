import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { PageHeader } from '@/components/layout/PageHeader'
import { StatCard } from '@/components/charts/StatCard'
import { TrendLineChart } from '@/components/charts/TrendLineChart'
import { PieDonutChart } from '@/components/charts/PieDonutChart'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card'
import { StatusPill } from '@/components/common/StatusPill'
import { VersionBadge } from '@/components/common/VersionBadge'
import { Button } from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'
import { governanceSystemApi } from '@/api/governance/system.api'
import { ingestHealthApi } from '@/api/ingest/health.api'
import { kbApi } from '@/api/governance/kb.api'
import { shadowApi } from '@/api/governance/shadow.api'
import { analyticsApi } from '@/api/governance/analytics.api'
import { formatDate } from '@/lib/dates'
import { formatDuration } from '@/lib/utils'
import { Ticket, Activity, Database, Server } from 'lucide-react'

const formatActionLabel = (value: string) =>
  value.replace(/_/g, ' ').toLowerCase().replace(/(^\w|\s\w)/g, (m) => m.toUpperCase())

export default function DashboardPage() {
  const { data: govStatus, isLoading: govLoading } = useQuery({
    queryKey: ['system', 'status', 'governance'],
    queryFn: () => governanceSystemApi.systemStatus().then((r) => r.data),
    refetchInterval: 30_000,
    retry: false,
  })

  const { data: ingestStatus, isLoading: ingestLoading } = useQuery({
    queryKey: ['system', 'status', 'ingest'],
    queryFn: () => ingestHealthApi.systemStatus().then((r) => r.data),
    refetchInterval: 30_000,
    retry: false,
  })

  const { data: workerHealth } = useQuery({
    queryKey: ['system', 'worker'],
    queryFn: () => governanceSystemApi.workerHealth().then((r) => r.data),
    refetchInterval: 30_000,
    retry: false,
  })

  const { data: kbActiveVersion } = useQuery({
    queryKey: ['kb', 'active-version'],
    queryFn: () => kbApi.getActiveVersion().then((r) => r.data),
    retry: false,
  })

  const { data: shadowStats } = useQuery({
    queryKey: ['shadow', 'stats'],
    queryFn: () => shadowApi.getStats().then((r) => r.data),
    refetchInterval: 15_000,
    retry: false,
  })

  const { data: analyticsSummary, isLoading: analyticsLoading } = useQuery({
    queryKey: ['analytics', 'summary'],
    queryFn: () => analyticsApi.getSummary({}).then((r) => r.data),
    refetchInterval: 30_000,
    retry: false,
  })

  const statusDot = (status: string | undefined) =>
    status === 'ok' ? 'healthy' : status === 'error' ? 'unhealthy' : 'degraded'

  const dailyTicketData = analyticsSummary?.daily_ticket_counts ?? []
  const actionDist = Object.entries(analyticsSummary?.action_code_distribution ?? {}).map(([name, value]) => ({
    name: formatActionLabel(name),
    value,
  }))

  const todayStr = new Date().toISOString().split('T')[0]
  const ticketsToday = dailyTicketData.find((d) => d.date === todayStr)?.count ?? 0

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle="System overview and key metrics"
      />

      {/* System Health Bar */}
      <Card className="mb-6">
        <CardContent className="py-3">
          <div className="flex flex-wrap items-center gap-6">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-subtle uppercase">System Health</span>
            </div>

            {/* Governance Plane */}
            <div className="flex items-center gap-2">
              <Server className="w-3.5 h-3.5 text-subtle" />
              <span className="text-xs text-muted">Governance</span>
              {govLoading ? <Skeleton className="w-16 h-4" /> : (
                <StatusPill status={govStatus?.status ?? 'unhealthy'} />
              )}
            </div>

            {/* Ingest Plane */}
            <div className="flex items-center gap-2">
              <Activity className="w-3.5 h-3.5 text-subtle" />
              <span className="text-xs text-muted">Ingest</span>
              {ingestLoading ? <Skeleton className="w-16 h-4" /> : (
                <StatusPill status={ingestStatus?.status ?? 'unhealthy'} />
              )}
            </div>

            {/* Database */}
            <div className="flex items-center gap-2">
              <Database className="w-3.5 h-3.5 text-subtle" />
              <span className="text-xs text-muted">Database</span>
              <StatusPill status={statusDot(govStatus?.database)} />
            </div>

            {/* Redis */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted">Redis</span>
              <StatusPill status={statusDot(govStatus?.redis)} />
            </div>

            {/* Vector Worker */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted">Vector Worker</span>
              <StatusPill status={workerHealth?.status === 'alive' ? 'healthy' : 'unhealthy'} />
              {workerHealth?.last_heartbeat_s != null && (
                <span className="text-xs text-subtle">({workerHealth.last_heartbeat_s}s ago)</span>
              )}
            </div>

            {/* Versions */}
            <div className="ml-auto flex items-center gap-2">
              {kbActiveVersion && (
                <VersionBadge version={kbActiveVersion.active_version} isActive />
              )}
              {shadowStats?.is_active && shadowStats.shadow_version && (
                <VersionBadge version={shadowStats.shadow_version} isShadow />
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* KPI Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard
          label="Tickets Today"
          value={analyticsLoading ? '—' : `${ticketsToday}`}
          subtitle={analyticsLoading ? 'Loading' : 'From latest ingest'}
          icon={<Ticket className="w-5 h-5 text-brand-500" />}
          highlight="blue"
        />
        <StatCard
          label="Avg Processing"
          value={analyticsLoading ? '—' : formatDuration(analyticsSummary?.avg_duration_ms)}
          subtitle="per ticket"
          highlight="green"
        />
        <StatCard
          label="CSAT Score"
          value={analyticsLoading ? '—' : `${(analyticsSummary?.avg_csat ?? 0).toFixed(2)}`}
          subtitle="Rolling 7d avg"
          highlight="amber"
        />
        <StatCard
          label="SLA Breach Rate"
          value={analyticsLoading ? '—' : `${((analyticsSummary?.sla_breach_rate ?? 0) * 100).toFixed(1)}%`}
          subtitle="Across processed tickets"
          highlight="red"
        />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <Card>
          <CardHeader>
            <CardTitle>Ticket Volume (Last 7 Days)</CardTitle>
          </CardHeader>
          <CardContent>
            <TrendLineChart
              data={dailyTicketData as unknown as Record<string, unknown>[]}
              lines={[{ key: 'count', name: 'Tickets', color: '#22c55e' }]}
              xKey="date"
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Action Code Distribution</CardTitle>
          </CardHeader>
          <CardContent>
            <PieDonutChart data={actionDist} />
          </CardContent>
        </Card>
      </div>

      {/* Shadow Policy Alert */}
      {shadowStats?.is_active && (
        <Card className="mb-6 border-amber-700/50 bg-amber-900/10">
          <CardContent className="py-3">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <span className="text-amber-400 font-medium text-sm">Shadow Policy Active</span>
                <VersionBadge version={shadowStats.shadow_version ?? ''} isShadow />
                <span className="text-xs text-muted">
                  vs active{' '}
                  <VersionBadge version={shadowStats.active_version ?? ''} isActive />
                </span>
              </div>
              <div className="flex items-center gap-4 text-xs">
                <span className="text-muted">
                  Evaluated: <span className="text-foreground font-medium">{shadowStats.total_evaluated}</span>
                </span>
                <span className="text-muted">
                  Changed: <span className="text-amber-300 font-medium">
                    {shadowStats.decisions_changed} ({(shadowStats.change_rate * 100).toFixed(1)}%)
                  </span>
                </span>
                <Link to="/policy/shadow">
                  <Button variant="outline" size="xs">View Stats</Button>
                </Link>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Quick Links */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: 'Browse Tickets', path: '/tickets', desc: 'View recent ticket processing' },
          { label: 'Taxonomy', path: '/taxonomy', desc: 'Manage issue classification tree' },
          { label: 'Knowledge Base', path: '/knowledge-base', desc: 'Upload & compile KB docs' },
          { label: 'Simulation', path: '/policy/simulation', desc: 'Compare policy versions' },
        ].map((link) => (
          <Link key={link.path} to={link.path}>
            <Card className="hover:border-brand-600/50 hover:bg-surface-card/80 transition-colors cursor-pointer">
              <CardContent className="py-3">
                <p className="text-sm font-medium text-foreground">{link.label}</p>
                <p className="text-xs text-subtle mt-0.5">{link.desc}</p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      {/* Last updated */}
      <p className="text-xs text-subtle text-center mt-6">
        System status auto-refreshes every 30s · Last checked {formatDate(new Date())}
      </p>
    </div>
  )
}
