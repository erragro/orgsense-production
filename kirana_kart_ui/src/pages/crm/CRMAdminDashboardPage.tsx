// CRMAdminDashboardPage.tsx — Admin team dashboard with queue health, SLA, agent perf, charts
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card,CardContent,CardHeader,CardTitle } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Spinner } from '@/components/ui/Spinner'
import { StatCard } from '@/components/charts/StatCard'
import { TrendLineChart } from '@/components/charts/TrendLineChart'
import { BarMetricChart } from '@/components/charts/BarMetricChart'
import { PieDonutChart } from '@/components/charts/PieDonutChart'
import { EmptyState } from '@/components/common/EmptyState'
import { crmApi } from '@/api/governance/crm.api'
import type { QueueType,QueueStatus } from '@/types/crm.types'
import {
QUEUE_TYPE_LABELS as QTL,STATUS_LABELS as SL,STATUS_COLORS as SC,
} from '@/types/crm.types'
import { cn } from '@/lib/cn'
import {
RefreshCw,CalendarRange,Layers,Users,AlertTriangle,Clock
} from 'lucide-react'

function todayMinus(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString().slice(0, 10)
}
function today(): string { return new Date().toISOString().slice(0, 10) }

const PRESET_RANGES = [
  { label: 'Today', from: todayMinus(0), to: today() },
  { label: '7d', from: todayMinus(7), to: today() },
  { label: '30d', from: todayMinus(30), to: today() },
  { label: '90d', from: todayMinus(90), to: today() },
]

const ALL_STATUSES: QueueStatus[] = ['OPEN', 'IN_PROGRESS', 'PENDING_CUSTOMER', 'ESCALATED', 'RESOLVED', 'CLOSED']

export default function CRMAdminDashboardPage() {
  const [dateFrom, setDateFrom] = useState(todayMinus(30))
  const [dateTo, setDateTo] = useState(today())
  const [sortField, setSortField] = useState<'tickets_handled' | 'avg_resolution_time_minutes' | 'approval_rate'>('tickets_handled')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['crm-admin-dashboard', dateFrom, dateTo],
    queryFn: () => crmApi.getAdminDashboard({ date_from: dateFrom, date_to: dateTo }).then(r => r.data),
    enabled: !!dateFrom && !!dateTo,
    refetchInterval: 120_000,
  })

  const sortedAgents = [...(data?.agent_performance ?? [])].sort((a, b) => {
    const va = a[sortField] ?? 0
    const vb = b[sortField] ?? 0
    return sortDir === 'desc' ? (vb as number) - (va as number) : (va as number) - (vb as number)
  })

  const toggleSort = (field: typeof sortField) => {
    if (sortField === field) setSortDir(d => d === 'desc' ? 'asc' : 'desc')
    else { setSortField(field); setSortDir('desc') }
  }

  // Compute summary totals from queue_health
  const totalOpen = data?.queue_health
    .filter(q => q.status === 'OPEN')
    .reduce((s, q) => s + q.count, 0) ?? 0

  const totalEscalated = data?.queue_health
    .filter(q => q.status === 'ESCALATED')
    .reduce((s, q) => s + q.count, 0) ?? 0

  const avgCompliance = data?.sla_compliance.length
    ? data.sla_compliance.reduce((s, r) => s + r.compliance_pct, 0) / data.sla_compliance.length
    : null

  const hitlTotal = (data?.auto_vs_hitl.hitl ?? 0) + (data?.auto_vs_hitl.manual ?? 0)

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        title="Team Dashboard"
        subtitle="CRM queue health, SLA compliance, and agent performance"
        actions={
          <Button variant="ghost" size="sm" onClick={() => refetch()}>
            <RefreshCw className={cn('w-4 h-4', isLoading && 'animate-spin')} />
          </Button>
        }
      />

      {/* Date Range */}
      <Card className="mb-6">
        <CardContent className="p-3 flex items-center gap-3 flex-wrap">
          <CalendarRange className="w-4 h-4 text-muted" />
          <Input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="h-8 text-sm w-36" />
          <span className="text-muted text-xs">to</span>
          <Input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="h-8 text-sm w-36" />
          <div className="flex gap-1">
            {PRESET_RANGES.map(pr => (
              <Button
                key={pr.label}
                variant="ghost"
                size="sm"
                className={cn('text-xs', dateFrom === pr.from && dateTo === pr.to && 'bg-brand-600/20 text-brand-400')}
                onClick={() => { setDateFrom(pr.from); setDateTo(pr.to) }}
              >
                {pr.label}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {isLoading && (
        <div className="flex h-40 items-center justify-center">
          <Spinner size="lg" />
        </div>
      )}

      {data && (
        <>
          {/* Top KPIs */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <StatCard label="Open Tickets" value={totalOpen} icon={<Layers className="w-4 h-4" />} />
            <StatCard label="Escalated" value={totalEscalated} icon={<AlertTriangle className="w-4 h-4" />} />
            <StatCard label="Avg SLA Compliance" value={avgCompliance != null ? `${avgCompliance.toFixed(1)}%` : '—'} icon={<Clock className="w-4 h-4" />} />
            <StatCard label="HITL Volume" value={hitlTotal} icon={<Users className="w-4 h-4" />} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
            {/* Queue Health Matrix */}
            <Card>
              <CardHeader><CardTitle className="text-sm">Queue Health</CardTitle></CardHeader>
              <CardContent>
                {data.queue_health.length === 0 ? (
                  <EmptyState title="No data" description="No queue data for this period." />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-surface-border">
                          <th className="p-2 text-left text-muted font-medium">Queue</th>
                          {ALL_STATUSES.map(s => (
                            <th key={s} className="p-2 text-center text-muted font-medium">{SL[s]}</th>
                          ))}
                          <th className="p-2 text-center text-muted font-medium">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(['STANDARD_REVIEW', 'SENIOR_REVIEW', 'SLA_BREACH_REVIEW', 'ESCALATION_QUEUE', 'MANUAL_REVIEW'] as QueueType[]).map(qt => {
                          const rowData: Record<string, number> = {}
                          data.queue_health.filter(r => r.queue_type === qt).forEach(r => { rowData[r.status] = r.count })
                          const rowTotal = Object.values(rowData).reduce((s, v) => s + v, 0)
                          if (!rowTotal) return null
                          return (
                            <tr key={qt} className="border-b border-surface-border hover:bg-surface/30">
                              <td className="p-2 font-medium text-foreground">{QTL[qt]}</td>
                              {ALL_STATUSES.map(s => (
                                <td key={s} className="p-2 text-center">
                                  {rowData[s] ? (
                                    <span className={cn('px-1.5 py-0.5 rounded text-xs font-bold', SC[s])}>
                                      {rowData[s]}
                                    </span>
                                  ) : (
                                    <span className="text-muted">—</span>
                                  )}
                                </td>
                              ))}
                              <td className="p-2 text-center font-bold text-foreground">{rowTotal}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Volume Trend */}
            <Card>
              <CardHeader><CardTitle className="text-sm">Volume Trend</CardTitle></CardHeader>
              <CardContent>
                {data.volume_trend.length === 0 ? (
                  <EmptyState title="No data" description="No volume data for this period." />
                ) : (
                  <TrendLineChart
                    lines={[{ key: "value", name: "Tickets", color: "#6366f1" }]}
                    data={data.volume_trend.map(d => ({ date: d.date, value: d.count }))}
                    height={180}
                  />
                )}
              </CardContent>
            </Card>

            {/* SLA Compliance */}
            <Card>
              <CardHeader><CardTitle className="text-sm">SLA Compliance by Queue</CardTitle></CardHeader>
              <CardContent>
                {data.sla_compliance.length === 0 ? (
                  <EmptyState title="No data" description="No SLA data for this period." />
                ) : (
                  <div className="space-y-3">
                    {data.sla_compliance.map(r => (
                      <div key={r.queue_type} className="space-y-1">
                        <div className="flex justify-between text-xs">
                          <span className="text-muted">{QTL[r.queue_type] ?? r.queue_type}</span>
                          <span className={cn('font-bold', r.compliance_pct >= 90 ? 'text-green-400' : r.compliance_pct >= 70 ? 'text-amber-400' : 'text-red-400')}>
                            {r.compliance_pct.toFixed(1)}%
                          </span>
                        </div>
                        <div className="h-2 bg-surface rounded-full overflow-hidden">
                          <div
                            className={cn('h-2 rounded-full', r.compliance_pct >= 90 ? 'bg-green-500' : r.compliance_pct >= 70 ? 'bg-amber-500' : 'bg-red-500')}
                            style={{ width: `${r.compliance_pct}%` }}
                          />
                        </div>
                        <p className="text-xs text-muted">{r.total} tickets total</p>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Auto vs HITL + Aging */}
            <div className="flex flex-col gap-4">
              <Card>
                <CardHeader><CardTitle className="text-sm">Auto vs HITL Split</CardTitle></CardHeader>
                <CardContent>
                  <PieDonutChart
                    data={[
                      { name: 'HITL', value: data.auto_vs_hitl.hitl },
                      { name: 'Manual Review', value: data.auto_vs_hitl.manual },
                    ]}
                    height={140}
                  />
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle className="text-sm">Ticket Aging</CardTitle></CardHeader>
                <CardContent>
                  {data.aging_buckets.length === 0 ? (
                    <EmptyState title="No data" description="No aging data." />
                  ) : (
                    <BarMetricChart
                    xKey="label" bars={[{ key: "value", name: "Tickets", color: "#6366f1" }]}
                      data={data.aging_buckets.map(b => ({ label: b.bucket, value: b.count }))}
                      height={120}
                    />
                  )}
                </CardContent>
              </Card>
            </div>
          </div>

          {/* Agent Performance Table */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center justify-between">
                <span>Agent Performance</span>
                <span className="text-xs text-muted font-normal">{sortedAgents.length} agents</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {sortedAgents.length === 0 ? (
                <EmptyState title="No agent data" description="No agent performance data for this period." />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-surface-border">
                        <th className="p-3 text-left text-xs font-semibold text-subtle uppercase tracking-wide">Agent</th>
                        <th
                          className="p-3 text-right text-xs font-semibold text-subtle uppercase tracking-wide cursor-pointer hover:text-foreground"
                          onClick={() => toggleSort('tickets_handled')}
                        >
                          Handled {sortField === 'tickets_handled' && (sortDir === 'desc' ? '↓' : '↑')}
                        </th>
                        <th
                          className="p-3 text-right text-xs font-semibold text-subtle uppercase tracking-wide cursor-pointer hover:text-foreground"
                          onClick={() => toggleSort('avg_resolution_time_minutes')}
                        >
                          Avg Res. {sortField === 'avg_resolution_time_minutes' && (sortDir === 'desc' ? '↓' : '↑')}
                        </th>
                        <th className="p-3 text-right text-xs font-semibold text-subtle uppercase tracking-wide">Avg First Resp.</th>
                        <th className="p-3 text-right text-xs font-semibold text-subtle uppercase tracking-wide">CSAT</th>
                        <th
                          className="p-3 text-right text-xs font-semibold text-subtle uppercase tracking-wide cursor-pointer hover:text-foreground"
                          onClick={() => toggleSort('approval_rate')}
                        >
                          Approval {sortField === 'approval_rate' && (sortDir === 'desc' ? '↓' : '↑')}
                        </th>
                        <th className="p-3 text-right text-xs font-semibold text-subtle uppercase tracking-wide">Open</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedAgents.map(agent => (
                        <tr key={agent.agent_id} className="border-b border-surface-border hover:bg-surface/40">
                          <td className="p-3">
                            <div className="flex items-center gap-2">
                              <div className="w-7 h-7 rounded-full bg-brand-600/20 flex items-center justify-center text-xs font-bold text-brand-300">
                                {agent.agent_name[0]}
                              </div>
                              <span className="font-medium text-foreground">{agent.agent_name}</span>
                            </div>
                          </td>
                          <td className="p-3 text-right font-medium">{agent.tickets_handled}</td>
                          <td className="p-3 text-right text-muted">
                            <span className={cn(
                              'text-xs',
                              agent.avg_resolution_time_minutes <= 240 ? 'text-green-400' :
                              agent.avg_resolution_time_minutes <= 480 ? 'text-amber-400' : 'text-red-400'
                            )}>
                              {Math.round(agent.avg_resolution_time_minutes)}m
                            </span>
                          </td>
                          <td className="p-3 text-right text-muted text-xs">
                            {Math.round(agent.avg_first_response_time_minutes)}m
                          </td>
                          <td className="p-3 text-right">
                            {agent.csat_average != null ? (
                              <span className={cn(
                                'text-xs font-medium',
                                agent.csat_average >= 4 ? 'text-green-400' :
                                agent.csat_average >= 3 ? 'text-amber-400' : 'text-red-400'
                              )}>
                                {agent.csat_average.toFixed(1)}
                              </span>
                            ) : (
                              <span className="text-muted text-xs">—</span>
                            )}
                          </td>
                          <td className="p-3 text-right">
                            {agent.approval_rate != null ? (
                              <span className={cn(
                                'text-xs font-medium',
                                agent.approval_rate >= 0.8 ? 'text-green-400' :
                                agent.approval_rate >= 0.6 ? 'text-amber-400' : 'text-red-400'
                              )}>
                                {(agent.approval_rate * 100).toFixed(0)}%
                              </span>
                            ) : (
                              <span className="text-muted text-xs">—</span>
                            )}
                          </td>
                          <td className="p-3 text-right">
                            <Badge variant={agent.open_count > 20 ? 'red' : agent.open_count > 10 ? 'amber' : 'green'} size="sm">
                              {agent.open_count}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
