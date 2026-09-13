// CRMReportsPage.tsx — CRM reports with date range, type selector, optional filters, dynamic table
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card,CardContent,CardHeader,CardTitle } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Spinner } from '@/components/ui/Spinner'
import { EmptyState } from '@/components/common/EmptyState'
import { Badge } from '@/components/ui/Badge'
import { BarMetricChart } from '@/components/charts/BarMetricChart'
import { crmApi } from '@/api/governance/crm.api'
import { cn } from '@/lib/cn'
import { FileBarChart2,Download,CalendarRange } from 'lucide-react'

function todayMinus(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString().slice(0, 10)
}
function today(): string { return new Date().toISOString().slice(0, 10) }

const REPORT_TYPES = [
  { value: 'volume_by_agent', label: 'Volume by Agent', description: 'Ticket volume handled per agent' },
  { value: 'sla_compliance', label: 'SLA Compliance', description: 'SLA compliance rate per queue type' },
  { value: 'resolution_time', label: 'Resolution Time', description: 'Average resolution time by queue type' },
  { value: 'action_code_distribution', label: 'Action Code Distribution', description: 'Frequency of each action code used' },
  { value: 'refund_analysis', label: 'Refund Analysis', description: 'AI-recommended vs final refund amounts per action code' },
  { value: 'first_response', label: 'First Response', description: 'First response SLA compliance per agent' },
]

const PRESET_RANGES = [
  { label: 'Today', from: todayMinus(0), to: today() },
  { label: '7d', from: todayMinus(7), to: today() },
  { label: '30d', from: todayMinus(30), to: today() },
  { label: '90d', from: todayMinus(90), to: today() },
]

function formatValue(val: unknown): string {
  if (val == null) return '—'
  if (typeof val === 'number') {
    if (Number.isInteger(val)) return val.toLocaleString('en-IN')
    return val.toFixed(2)
  }
  return String(val)
}

// Render a dynamic table from array of objects
function DynamicTable({ rows }: { rows: Record<string, unknown>[] }) {
  if (!rows.length) return <EmptyState title="No results" description="No data for the selected filters." />

  const keys = Object.keys(rows[0])
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-surface-border bg-surface/50">
            {keys.map(k => (
              <th key={k} className="p-3 text-left text-xs font-semibold text-subtle uppercase tracking-wide">
                {k.replace(/_/g, ' ')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-surface-border hover:bg-surface/40">
              {keys.map(k => {
                const v = row[k]
                const isNum = typeof v === 'number'
                const isPct = typeof k === 'string' && k.includes('pct')
                const isAmt = typeof k === 'string' && (k.includes('refund') || k.includes('amount'))
                return (
                  <td key={k} className={cn('p-3', isNum && 'text-right font-mono')}>
                    {isPct && typeof v === 'number' ? (
                      <span className={cn('text-xs font-bold', v >= 90 ? 'text-green-400' : v >= 70 ? 'text-amber-400' : 'text-red-400')}>
                        {v.toFixed(1)}%
                      </span>
                    ) : isAmt && typeof v === 'number' ? (
                      <span className="text-green-400">₹{v.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>
                    ) : (
                      formatValue(v)
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function CRMReportsPage() {
  const [reportType, setReportType] = useState('volume_by_agent')
  const [dateFrom, setDateFrom] = useState(todayMinus(30))
  const [dateTo, setDateTo] = useState(today())
  const [queueType, setQueueType] = useState('')
  const [agentId, setAgentId] = useState('')
  const [hasRun, setHasRun] = useState(false)

  const { data: agents } = useQuery({
    queryKey: ['crm-agents'],
    queryFn: () => crmApi.getAgents().then(r => r.data),
  })

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['crm-report', reportType, dateFrom, dateTo, queueType, agentId],
    queryFn: () => crmApi.getReport({
      report_type: reportType,
      date_from: dateFrom,
      date_to: dateTo,
      queue_type: queueType || undefined,
      agent_id: agentId ? Number(agentId) : undefined,
    }).then(r => r.data),
    enabled: hasRun,
  })

  const rows = data ?? []
  const selectedReport = REPORT_TYPES.find(r => r.value === reportType)

  const downloadCSV = () => {
    if (!rows.length) return
    const keys = Object.keys(rows[0])
    const csvContent = [
      keys.join(','),
      ...rows.map(row => keys.map(k => `"${String(row[k] ?? '').replace(/"/g, '""')}"`).join(',')),
    ].join('\n')
    const blob = new Blob([csvContent], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${reportType}_${dateFrom}_${dateTo}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        title="Reports"
        subtitle="Detailed CRM analytics and exports"
        actions={
          <div className="flex items-center gap-2">
            {rows.length > 0 && (
              <Button variant="ghost" size="sm" onClick={downloadCSV}>
                <Download className="w-4 h-4 mr-1" /> Export CSV
              </Button>
            )}
          </div>
        }
      />

      {/* Report Type Selector */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-6">
        {REPORT_TYPES.map(rt => (
          <button
            key={rt.value}
            onClick={() => { setReportType(rt.value); setHasRun(false) }}
            className={cn(
              'text-left p-3 rounded-lg border transition-colors',
              reportType === rt.value
                ? 'border-brand-600 bg-brand-600/10 text-foreground'
                : 'border-surface-border bg-surface-card hover:bg-surface/60 text-muted'
            )}
          >
            <p className="text-sm font-medium">{rt.label}</p>
            <p className="text-xs mt-0.5 opacity-70">{rt.description}</p>
          </button>
        ))}
      </div>

      {/* Filters */}
      <Card className="mb-6">
        <CardContent className="p-4 flex items-center gap-3 flex-wrap">
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

          <Select
            options={[
              { value: '', label: 'All Queues' },
              { value: 'STANDARD_REVIEW', label: 'Standard Review' },
              { value: 'SENIOR_REVIEW', label: 'Senior Review' },
              { value: 'SLA_BREACH_REVIEW', label: 'SLA Breach' },
              { value: 'ESCALATION_QUEUE', label: 'Escalation' },
              { value: 'MANUAL_REVIEW', label: 'Manual Review' },
            ]}
            value={queueType}
            onChange={e => setQueueType(e.target.value)}
          />

          <Select
            options={[
              { value: '', label: 'All Agents' },
              ...(agents ?? []).map(a => ({ value: String(a.id), label: a.full_name })),
            ]}
            value={agentId}
            onChange={e => setAgentId(e.target.value)}
          />

          <Button onClick={() => { setHasRun(true); refetch() }} disabled={isLoading}>
            {isLoading ? <Spinner size="sm" /> : <><FileBarChart2 className="w-4 h-4 mr-1" /> Run Report</>}
          </Button>
        </CardContent>
      </Card>

      {/* Results */}
      {!hasRun && (
        <div className="text-center py-16 text-muted">
          <FileBarChart2 className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="text-sm">Select a report type and filters, then click <strong>Run Report</strong>.</p>
        </div>
      )}

      {hasRun && isLoading && (
        <div className="flex h-40 items-center justify-center">
          <Spinner size="lg" />
        </div>
      )}

      {hasRun && !isLoading && rows && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center justify-between">
              <span>{selectedReport?.label}</span>
              <div className="flex items-center gap-2">
                <Badge variant="gray" size="sm">{rows.length} rows</Badge>
                <span className="text-xs text-muted">{dateFrom} → {dateTo}</span>
              </div>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {/* Optional inline chart for certain report types */}
            {reportType === 'volume_by_agent' && rows.length > 0 && (
              <div className="mb-6">
                <BarMetricChart
                    xKey="label" bars={[{ key: "value", name: "Tickets", color: "#6366f1" }]}
                  data={(rows as any[]).map(r => ({
                    label: r.agent_name ?? r.agent_id ?? '?',
                    value: r.tickets_handled ?? 0,
                  }))}
                  height={160}
                />
              </div>
            )}
            {reportType === 'action_code_distribution' && rows.length > 0 && (
              <div className="mb-6">
                <BarMetricChart
                    xKey="label" bars={[{ key: "value", name: "Tickets", color: "#6366f1" }]}
                  data={(rows as any[]).slice(0, 10).map(r => ({
                    label: r.action_code_id ?? '?',
                    value: r.count ?? 0,
                  }))}
                  height={160}
                />
              </div>
            )}
            <DynamicTable rows={rows as Record<string, unknown>[]} />
          </CardContent>
        </Card>
      )}
    </div>
  )
}
