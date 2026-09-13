// CRMAgentDashboardPage.tsx — Agent personal performance dashboard
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card,CardContent,CardHeader,CardTitle } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Spinner } from '@/components/ui/Spinner'
import { StatCard } from '@/components/charts/StatCard'
import { EmptyState } from '@/components/common/EmptyState'
import { crmApi } from '@/api/governance/crm.api'
import { useAuthStore } from '@/stores/auth.store'
import {
STATUS_LABELS as SL,STATUS_COLORS as SC,ACTION_TYPE_LABELS as ATL,
} from '@/types/crm.types'
import { cn } from '@/lib/cn'
import {
Ticket,Clock,CheckCircle2,Star,TrendingUp,
RefreshCw,CalendarRange
} from 'lucide-react'

function todayMinus(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString().slice(0, 10)
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

const PRESET_RANGES = [
  { label: 'Today', from: todayMinus(0), to: today() },
  { label: 'Last 7 days', from: todayMinus(7), to: today() },
  { label: 'Last 30 days', from: todayMinus(30), to: today() },
  { label: 'Last 90 days', from: todayMinus(90), to: today() },
]

export default function CRMAgentDashboardPage() {
  const { user } = useAuthStore()
  const [dateFrom, setDateFrom] = useState(todayMinus(30))
  const [dateTo, setDateTo] = useState(today())

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['crm-agent-dashboard', dateFrom, dateTo],
    queryFn: () => crmApi.getAgentDashboard({ date_from: dateFrom, date_to: dateTo }).then(r => r.data),
    enabled: !!dateFrom && !!dateTo,
  })

  const myQueue = data?.my_queue ?? {}
  const totalOpen = Object.values(myQueue).reduce((s, v) => s + (v ?? 0), 0)

  const statusOrder: Array<keyof typeof SL> = ['OPEN', 'IN_PROGRESS', 'PENDING_CUSTOMER', 'ESCALATED', 'RESOLVED', 'CLOSED']

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <PageHeader
        title="My Dashboard"
        subtitle={`${user?.full_name ?? 'Agent'} · Personal Performance`}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => refetch()}>
              <RefreshCw className={cn('w-4 h-4', isLoading && 'animate-spin')} />
            </Button>
          </div>
        }
      />

      {/* Date Range */}
      <Card className="mb-6">
        <CardContent className="p-3 flex items-center gap-3 flex-wrap">
          <CalendarRange className="w-4 h-4 text-muted" />
          <Input
            type="date"
            value={dateFrom}
            onChange={e => setDateFrom(e.target.value)}
            className="h-8 text-sm w-36"
          />
          <span className="text-muted text-xs">to</span>
          <Input
            type="date"
            value={dateTo}
            onChange={e => setDateTo(e.target.value)}
            className="h-8 text-sm w-36"
          />
          <div className="flex gap-1">
            {PRESET_RANGES.map(pr => (
              <Button
                key={pr.label}
                variant="ghost"
                size="sm"
                className={cn(
                  'text-xs',
                  dateFrom === pr.from && dateTo === pr.to && 'bg-brand-600/20 text-brand-400'
                )}
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
          {/* KPI Cards */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4 mb-6">
            <StatCard
              label="Tickets Handled"
              value={data.tickets_handled}
              icon={<Ticket className="w-4 h-4" />}
            />
            <StatCard
              label="Avg Resolution"
              value={`${Math.round(data.avg_resolution_time_minutes)}m`}
              icon={<Clock className="w-4 h-4" />}
            />
            <StatCard
              label="Avg First Response"
              value={`${Math.round(data.avg_first_response_time_minutes)}m`}
              icon={<TrendingUp className="w-4 h-4" />}
            />
            <StatCard
              label="CSAT Score"
              value={data.csat_average != null ? `${data.csat_average.toFixed(1)}/5` : '—'}
              icon={<Star className="w-4 h-4" />}
            />
            <StatCard
              label="Approval Rate"
              value={data.approval_rate != null ? `${(data.approval_rate * 100).toFixed(0)}%` : '—'}
              icon={<CheckCircle2 className="w-4 h-4" />}
            />
          </div>

          {/* My Queue Breakdown */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
            <Card>
              <CardHeader><CardTitle className="text-sm">My Queue Breakdown</CardTitle></CardHeader>
              <CardContent>
                {totalOpen === 0 ? (
                  <EmptyState title="Queue empty" description="No open tickets in selected period." />
                ) : (
                  <div className="space-y-2">
                    {statusOrder.map(status => {
                      const count = myQueue[status] ?? 0
                      if (!count) return null
                      const pct = Math.round((count / totalOpen) * 100)
                      return (
                        <div key={status} className="flex items-center gap-3">
                          <span className={cn('text-xs px-2 py-0.5 rounded-full font-medium w-32 text-center', SC[status])}>
                            {SL[status]}
                          </span>
                          <div className="flex-1 h-2 bg-surface rounded-full overflow-hidden">
                            <div
                              className="h-2 rounded-full bg-brand-500"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className="text-xs font-bold text-foreground w-6 text-right">{count}</span>
                        </div>
                      )
                    })}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Recent Actions */}
            <Card>
              <CardHeader><CardTitle className="text-sm">Recent Actions</CardTitle></CardHeader>
              <CardContent>
                {(data.recent_actions ?? []).length === 0 ? (
                  <EmptyState title="No actions" description="No actions taken in this period." />
                ) : (
                  <div className="space-y-1 max-h-56 overflow-y-auto">
                    {data.recent_actions.slice(0, 15).map(action => (
                      <div key={action.id} className="flex items-center justify-between py-1 border-b border-surface-border last:border-0 text-xs">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-muted shrink-0">#{action.ticket_id}</span>
                          <span className="text-foreground truncate">{ATL[action.action_type] ?? action.action_type}</span>
                        </div>
                        <span className="text-muted shrink-0">
                          {new Date(action.created_at).toLocaleString('en-IN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Performance Tips */}
          {data.avg_resolution_time_minutes > 480 && (
            <div className="bg-amber-950/20 border border-amber-700/30 rounded-md p-3 text-sm text-amber-300 flex items-start gap-2">
              <TrendingUp className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <strong>Tip:</strong> Your average resolution time is above 8 hours. Consider reviewing ticket prioritization or seeking senior review support.
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
