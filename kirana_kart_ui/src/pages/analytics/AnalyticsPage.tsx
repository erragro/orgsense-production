// src/pages/analytics/AnalyticsPage.tsx
// Tabs: resolution | csat | refunds | sla | evaluations
// Evaluation Matrix: full source→eval→validation column set, per-page stat cards,
// grouped col headers, removable filter chips, skeleton rows, formatted numerics.
// API: analyticsApi (analytics.api.ts) → EvaluationResponse / EvaluationFilters (analytics.types.ts)

import { type ReactNode,useMemo,useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card,CardContent,CardHeader,CardTitle } from '@/components/ui/Card'
import { StatCard } from '@/components/charts/StatCard'
import { TrendLineChart } from '@/components/charts/TrendLineChart'
import { BarMetricChart } from '@/components/charts/BarMetricChart'
import { PieDonutChart } from '@/components/charts/PieDonutChart'
import { EmptyState } from '@/components/common/EmptyState'
import { Skeleton } from '@/components/ui/Skeleton'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import { PaginationBar } from '@/components/common/PaginationBar'
import { analyticsApi } from '@/api/governance/analytics.api'
import type { EvaluationRecord,EvaluationResponse } from '@/types/analytics.types'
import { formatCurrency,formatDuration,formatPercent } from '@/lib/utils'
import { cn } from '@/lib/cn'
import { BarChart3,X,AlertTriangle,CheckCircle2,Clock } from 'lucide-react'

type Tab = 'resolution' | 'csat' | 'refunds' | 'sla' | 'evaluations' | 'fcr' | 'spikes' | 'agent_quality'

const PAGE_SIZE = 50

// ─── Column layout for the Evaluation Matrix table ───────────────────────────
// Groups: IDENTITY (4) | SOURCE (8) | EVALUATION (9) | VALIDATION (10)
const COL_GROUPS = [
  {
    label: 'Identity',
    span: 4,
    className: 'bg-slate-100 text-foreground dark:bg-slate-800/60',
    borderClass: 'border-l-0',
  },
  {
    label: 'Source Data',
    span: 8,
    className: 'bg-amber-900/20 text-amber-300',
    borderClass: 'border-l border-amber-800/40',
  },
  {
    label: 'Evaluation  ·  llm_output_2',
    span: 9,
    className: 'bg-blue-900/20 text-blue-300',
    borderClass: 'border-l border-blue-800/40',
  },
  {
    label: 'Validation  ·  llm_output_3',
    span: 10,
    className: 'bg-purple-900/20 text-purple-300',
    borderClass: 'border-l border-purple-800/40',
  },
] as const

const COLUMN_DEFS: { label: string; group: 0 | 1 | 2 | 3; render: (r: EvaluationRecord) => ReactNode }[] = [
  // ── IDENTITY ──
  { label: 'Ticket',        group: 0, render: (r) => <span className="font-mono text-brand-400">#{r.ticket_id}</span> },
  { label: 'Order',         group: 0, render: (r) => <span className="font-mono text-foreground">{r.order_id ?? '—'}</span> },
  { label: 'Module',        group: 0, render: (r) => r.module ?? '—' },
  { label: 'Pipeline Stage',group: 0, render: (r) => r.pipeline_stage ?? '—' },

  // ── SOURCE ──
  { label: 'Issue L1 (src)',      group: 1, render: (r) => r.source_issue_l1 ?? '—' },
  { label: 'Fraud Seg (src)',     group: 1, render: (r) => r.source_fraud_segment ?? '—' },
  { label: 'Value Seg (src)',     group: 1, render: (r) => r.source_value_segment ?? '—' },
  { label: 'CLM Seg (src)',       group: 1, render: (r) => r.source_clm_segment ?? '—' },
  { label: 'Complaint ₹ (src)',   group: 1, render: (r) => r.source_complaint_amount != null ? formatCurrency(r.source_complaint_amount) : '—' },
  { label: 'Order Val ₹ (src)',   group: 1, render: (r) => r.source_order_value != null ? formatCurrency(r.source_order_value) : '—' },
  { label: 'HRX Flag (src)',      group: 1, render: (r) => r.source_hrx_flag != null ? (r.source_hrx_flag ? 'Yes' : 'No') : '—' },
  { label: 'AON (src)',           group: 1, render: (r) => r.source_aon != null ? String(r.source_aon) : '—' },

  // ── EVALUATION ──
  { label: 'Eval Issue L1',    group: 2, render: (r) => r.eval_issue_l1 ?? '—' },
  { label: 'Eval Issue L2',    group: 2, render: (r) => r.eval_issue_l2 ?? '—' },
  { label: 'Std Logic',        group: 2, render: (r) => r.eval_standard_logic_passed == null ? '—' : r.eval_standard_logic_passed ? <span className="text-green-400">Pass</span> : <span className="text-red-400">Fail</span> },
  { label: 'Greedy Class',     group: 2, render: (r) => r.eval_greedy_classification ? <span className={r.eval_greedy_classification === 'GREEDY' ? 'text-red-400 font-medium' : 'text-foreground'}>{r.eval_greedy_classification}</span> : '—' },
  { label: 'Multiplier',       group: 2, render: (r) => r.eval_multiplier != null ? `×${r.eval_multiplier}` : '—' },
  { label: 'Capped Grat ₹',   group: 2, render: (r) => r.eval_capped_gratification != null ? <span className="text-green-300 font-mono">{formatCurrency(r.eval_capped_gratification)}</span> : '—' },
  { label: 'Cap Applied',      group: 2, render: (r) => r.eval_cap_applied ?? '—' },
  { label: 'Action Code',      group: 2, render: (r) => r.eval_action_code ? <span className="font-mono text-brand-300">{r.eval_action_code}</span> : '—' },
  { label: 'Confidence',       group: 2, render: (r) => r.eval_overall_confidence != null ? <span className="font-mono text-foreground">{formatPercent(r.eval_overall_confidence)}</span> : '—' },

  // ── VALIDATION ──
  { label: 'Val Std Logic',   group: 3, render: (r) => r.val_standard_logic == null ? '—' : r.val_standard_logic ? <span className="text-green-400">Pass</span> : <span className="text-red-400">Fail</span> },
  { label: 'Val Greedy',      group: 3, render: (r) => r.val_greedy_classification ? <span className={r.val_greedy_classification === 'GREEDY' ? 'text-red-400 font-medium' : 'text-foreground'}>{r.val_greedy_classification}</span> : '—' },
  { label: 'LLM Accuracy',    group: 3, render: (r) => r.val_llm_accuracy != null ? <span className="font-mono">{formatPercent(r.val_llm_accuracy)}</span> : '—' },
  { label: 'Discrepancy',     group: 3, render: (r) => r.val_discrepancy_detected == null ? '—' : r.val_discrepancy_detected ? <span className="text-red-400 font-medium">Yes</span> : <span className="text-green-400">No</span> },
  { label: 'Discrep Sev',     group: 3, render: (r) => r.val_discrepancy_severity ?? '—' },
  { label: 'Override',        group: 3, render: (r) => r.val_override_applied == null ? '—' : r.val_override_applied ? <span className="text-amber-400">Yes</span> : 'No' },
  { label: 'Override Type',   group: 3, render: (r) => r.val_override_type ?? '—' },
  { label: 'Pathway',         group: 3, render: (r) => r.val_automation_pathway ?? '—' },
  { label: 'Final Action',    group: 3, render: (r) => r.val_final_action_code ? <span className="font-mono text-brand-400 font-bold">{r.val_final_action_code}</span> : '—' },
  { label: 'Final Refund ₹', group: 3, render: (r) => r.val_final_refund_amount != null ? <span className="text-green-300 font-mono">{formatCurrency(r.val_final_refund_amount)}</span> : '—' },
]

// ─── Per-page stat derivation ─────────────────────────────────────────────────
function derivePageStats(items: EvaluationRecord[]) {
  const n = items.length
  if (n === 0) return null
  const stdPassed   = items.filter((r) => r.eval_standard_logic_passed === true).length
  const greedy      = items.filter((r) => r.eval_greedy_classification === 'GREEDY').length
  const discrepancy = items.filter((r) => r.val_discrepancy_detected === true).length
  const override    = items.filter((r) => r.val_override_applied === true).length
  const confVals    = items.map((r) => r.eval_overall_confidence).filter((v): v is number => v != null)
  const avgConf     = confVals.length > 0 ? confVals.reduce((a, b) => a + b, 0) / confVals.length : null
  return {
    stdLogicRate:    stdPassed   / n,
    greedyRate:      greedy      / n,
    discrepancyRate: discrepancy / n,
    overrideRate:    override    / n,
    avgConfidence:   avgConf,
  }
}

// ─── Removable filter chip ────────────────────────────────────────────────────
function FilterChip({ label, value, onRemove }: { label: string; value: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-brand-900/40 border border-brand-700/60 text-brand-300">
      <span className="text-muted">{label}:</span> {value}
      <button onClick={onRemove} className="ml-0.5 hover:text-foreground transition-colors">
        <X className="w-3 h-3" />
      </button>
    </span>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function AnalyticsPage() {
  const [activeTab, setActiveTab] = useState<Tab>('resolution')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  // Evaluation tab filter state — each maps to a query param in analyticsApi.getEvaluations
  const [evalPage, setEvalPage] = useState(1)
  const [evalModule,               setEvalModule]               = useState('')
  const [evalIssueL1,              setEvalIssueL1]              = useState('')
  const [evalIssueL2,              setEvalIssueL2]              = useState('')
  const [evalFraudSegment,         setEvalFraudSegment]         = useState('')
  const [evalValueSegment,         setEvalValueSegment]         = useState('')
  const [evalActionCode,           setEvalActionCode]           = useState('')
  const [evalAutomationPathway,    setEvalAutomationPathway]    = useState('')
  const [evalGreedyClassification, setEvalGreedyClassification] = useState('')
  const [evalPipelineStage,        setEvalPipelineStage]        = useState('')
  const [evalStandardLogic,        setEvalStandardLogic]        = useState('')
  const [evalOverrideApplied,      setEvalOverrideApplied]      = useState('')

  // ── FCR / Spikes / Agent Quality filter state ──
  const [spikeLimit] = useState(20)
  const [aqPage,     setAqPage]     = useState(1)
  const [aqResolved, setAqResolved] = useState('')

  // ── Summary data (resolution / csat / refunds / sla tabs) ──
  const { data: summaryData, isError: summaryError } = useQuery({
    queryKey: ['analytics', 'summary', { dateFrom, dateTo }],
    queryFn: () =>
      analyticsApi.getSummary({ date_from: dateFrom || undefined, date_to: dateTo || undefined }).then((r) => r.data),
  })

  // ── Evaluation filter option lists (distinct values from backend) ──
  const { data: evaluationFilters } = useQuery({
    queryKey: ['analytics', 'evaluation-filters'],
    queryFn: () => analyticsApi.getEvaluationFilters().then((r) => r.data),
    staleTime: 60_000,
  })

  // ── Evaluation rows (paged) ──
  const evaluationParams = useMemo(() => ({
    page: evalPage,
    limit: PAGE_SIZE,
    date_from:              dateFrom || undefined,
    date_to:                dateTo   || undefined,
    module:                 evalModule               || undefined,
    issue_l1:               evalIssueL1              || undefined,
    issue_l2:               evalIssueL2              || undefined,
    fraud_segment:          evalFraudSegment         || undefined,
    value_segment:          evalValueSegment         || undefined,
    action_code:            evalActionCode           || undefined,
    automation_pathway:     evalAutomationPathway    || undefined,
    greedy_classification:  evalGreedyClassification || undefined,
    pipeline_stage:         evalPipelineStage        || undefined,
    standard_logic_passed:  evalStandardLogic        || undefined,
    override_applied:       evalOverrideApplied      || undefined,
  }), [
    evalPage, dateFrom, dateTo, evalModule, evalIssueL1, evalIssueL2,
    evalFraudSegment, evalValueSegment, evalActionCode, evalAutomationPathway,
    evalGreedyClassification, evalPipelineStage, evalStandardLogic, evalOverrideApplied,
  ])

  const { data: evaluationData, isLoading: evaluationLoading } = useQuery<EvaluationResponse>({
    queryKey: ['analytics', 'evaluations', evaluationParams],
    queryFn: () => analyticsApi.getEvaluations(evaluationParams).then((r) => r.data),
    enabled: activeTab === 'evaluations',
  })

  const { data: fcrData, isLoading: fcrLoading } = useQuery({
    queryKey: ['analytics', 'fcr', { dateFrom, dateTo }],
    queryFn: () => analyticsApi.getFCR({ date_from: dateFrom || undefined, date_to: dateTo || undefined }).then((r) => r.data),
    enabled: activeTab === 'fcr',
  })

  const { data: spikesData, isLoading: spikesLoading } = useQuery({
    queryKey: ['analytics', 'spikes', spikeLimit],
    queryFn: () => analyticsApi.getSpikes({ limit: spikeLimit }).then((r) => r.data),
    enabled: activeTab === 'spikes',
  })

  const { data: aqData, isLoading: aqLoading } = useQuery({
    queryKey: ['analytics', 'agent-quality', { aqPage, aqResolved }],
    queryFn: () => analyticsApi.getAgentQuality({ page: aqPage, limit: 50, resolved: aqResolved || undefined }).then((r) => r.data),
    enabled: activeTab === 'agent_quality',
  })

  // ── Active filter chips ──
  const activeFilters: { label: string; value: string; clear: () => void }[] = [
    evalModule               && { label: 'Module',       value: evalModule,               clear: () => { setEvalModule('');               setEvalPage(1) } },
    evalIssueL1              && { label: 'Issue L1',     value: evalIssueL1,              clear: () => { setEvalIssueL1('');              setEvalPage(1) } },
    evalIssueL2              && { label: 'Issue L2',     value: evalIssueL2,              clear: () => { setEvalIssueL2('');              setEvalPage(1) } },
    evalFraudSegment         && { label: 'Fraud Seg',    value: evalFraudSegment,         clear: () => { setEvalFraudSegment('');         setEvalPage(1) } },
    evalValueSegment         && { label: 'Value Seg',    value: evalValueSegment,         clear: () => { setEvalValueSegment('');         setEvalPage(1) } },
    evalActionCode           && { label: 'Action Code',  value: evalActionCode,           clear: () => { setEvalActionCode('');           setEvalPage(1) } },
    evalAutomationPathway    && { label: 'Pathway',      value: evalAutomationPathway,    clear: () => { setEvalAutomationPathway('');    setEvalPage(1) } },
    evalGreedyClassification && { label: 'Greedy',       value: evalGreedyClassification, clear: () => { setEvalGreedyClassification(''); setEvalPage(1) } },
    evalPipelineStage        && { label: 'P. Stage',     value: evalPipelineStage,        clear: () => { setEvalPipelineStage('');        setEvalPage(1) } },
    evalStandardLogic        && { label: 'Std Logic',    value: evalStandardLogic === 'true' ? 'Passed' : 'Failed', clear: () => { setEvalStandardLogic(''); setEvalPage(1) } },
    evalOverrideApplied      && { label: 'Override',     value: evalOverrideApplied === 'true' ? 'Yes' : 'No',      clear: () => { setEvalOverrideApplied(''); setEvalPage(1) } },
  ].filter(Boolean) as { label: string; value: string; clear: () => void }[]

  const clearAllFilters = () => {
    setEvalModule(''); setEvalIssueL1(''); setEvalIssueL2('')
    setEvalFraudSegment(''); setEvalValueSegment(''); setEvalActionCode('')
    setEvalAutomationPathway(''); setEvalGreedyClassification(''); setEvalPipelineStage('')
    setEvalStandardLogic(''); setEvalOverrideApplied(''); setEvalPage(1)
  }

  // Page-level stats (approximation from current page items)
  const pageStats = useMemo(
    () => derivePageStats(evaluationData?.items ?? []),
    [evaluationData?.items],
  )

  const TABS: { key: Tab; label: string }[] = [
    { key: 'resolution',   label: 'Resolution' },
    { key: 'csat',         label: 'CSAT' },
    { key: 'refunds',      label: 'Refunds' },
    { key: 'sla',          label: 'SLA Breach' },
    { key: 'evaluations',  label: 'Evaluation Matrix' },
    { key: 'fcr',          label: 'True FCR' },
    { key: 'spikes',       label: 'Spike Reports' },
    { key: 'agent_quality',label: 'Agent Quality' },
  ]

  const SUMMARY_TABS: Tab[] = ['resolution', 'csat', 'refunds', 'sla']
  // For summary-based tabs, show placeholder if summary is unavailable
  const showSummaryPlaceholder = SUMMARY_TABS.includes(activeTab) && (summaryError || !summaryData)

  const makeOptions = (vals: string[] | undefined, placeholder: string) => [
    { value: '', label: placeholder },
    ...(vals ?? []).map((v) => ({ value: v, label: v })),
  ]

  return (
    <div>
      <PageHeader title="Analytics" subtitle="Ticket resolution, CSAT, refunds, SLA and evaluation matrix" />

      {/* Global date range — applies to summary AND evaluation queries */}
      <div className="flex gap-3 mb-4 items-center flex-wrap">
        <label className="text-xs text-muted shrink-0">Date Range:</label>
        <Input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setEvalPage(1) }} className="w-40" />
        <span className="text-subtle text-xs">to</span>
        <Input type="date" value={dateTo}   onChange={(e) => { setDateTo(e.target.value);   setEvalPage(1) }} className="w-40" />
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 mb-4 border-b border-surface-border overflow-x-auto">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              'px-4 py-2 text-sm font-medium border-b-2 whitespace-nowrap transition-colors',
              activeTab === tab.key
                ? 'border-brand-500 text-brand-400'
                : 'border-transparent text-muted hover:text-foreground',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── Summary tabs ──────────────────────────────────────────── */}
      {showSummaryPlaceholder ? (
        <Card>
          <CardContent>
            <EmptyState
              icon={<BarChart3 className="w-10 h-10 text-subtle" />}
              title="Failed to load analytics"
              description="Could not reach the governance plane. Ensure the backend is running on port 8001."
            />
          </CardContent>
        </Card>
      ) : (
        <>
          {activeTab === 'resolution' && summaryData && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <StatCard label="Total Tickets"         value={summaryData.total_tickets.toLocaleString()} />
                <StatCard label="Avg Processing"        value={formatDuration(summaryData.avg_duration_ms)} />
                <StatCard label="P95 Processing"        value={formatDuration(summaryData.p95_duration_ms)} />
                <StatCard label="Auto-Resolution Rate"  value={formatPercent(summaryData.auto_resolution_rate)} highlight="green" />
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <Card>
                  <CardHeader><CardTitle>Daily Ticket Volume</CardTitle></CardHeader>
                  <CardContent>
                    <BarMetricChart
                      data={summaryData.daily_ticket_counts as unknown as Record<string, unknown>[]}
                      bars={[{ key: 'count', name: 'Tickets', color: '#22c55e' }]}
                    />
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader><CardTitle>Action Code Distribution</CardTitle></CardHeader>
                  <CardContent>
                    <PieDonutChart
                      data={Object.entries(summaryData.action_code_distribution).map(([name, value]) => ({ name, value }))}
                    />
                  </CardContent>
                </Card>
              </div>
            </div>
          )}

          {activeTab === 'csat' && summaryData && (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-4">
                <StatCard label="Avg CSAT Score" value={summaryData.avg_csat.toFixed(2)} highlight="green" subtitle="out of 5.0" />
              </div>
              <Card>
                <CardHeader><CardTitle>CSAT Trend</CardTitle></CardHeader>
                <CardContent>
                  <TrendLineChart
                    data={summaryData.csat_trend as unknown as Record<string, unknown>[]}
                    lines={[{ key: 'value', name: 'CSAT', color: '#f59e0b' }]}
                  />
                </CardContent>
              </Card>
            </div>
          )}

          {activeTab === 'refunds' && summaryData && (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-4">
                <StatCard label="Total Refund Amount" value={formatCurrency(summaryData.total_refund_amount)} highlight="red" />
              </div>
              <Card>
                <CardHeader><CardTitle>Refunds by Day</CardTitle></CardHeader>
                <CardContent>
                  <BarMetricChart
                    data={summaryData.refund_by_day as unknown as Record<string, unknown>[]}
                    bars={[{ key: 'value', name: 'Refund Amount (₹)', color: '#ef4444' }]}
                  />
                </CardContent>
              </Card>
            </div>
          )}

          {activeTab === 'sla' && summaryData && (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-4">
                <StatCard
                  label="SLA Breach Rate"
                  value={formatPercent(summaryData.sla_breach_rate)}
                  highlight={summaryData.sla_breach_rate > 0.1 ? 'red' : 'green'}
                />
              </div>
            </div>
          )}

          {/* ── True FCR ─────────────────────────────────────────── */}
          {activeTab === 'fcr' && (
            <div className="space-y-4">
              {fcrLoading ? (
                <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24 w-full" />)}</div>
              ) : !fcrData ? (
                <Card><CardContent><EmptyState icon={<CheckCircle2 className="w-10 h-10 text-subtle" />} title="No FCR data" description="FCR data will appear after the async checker has run (48 h post-resolution)." /></CardContent></Card>
              ) : (
                <>
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                    <StatCard label="Total FCR Checked"  value={fcrData.total_checked.toLocaleString()} />
                    <StatCard label="True FCR Rate"       value={fcrData.true_fcr_rate != null ? formatPercent(fcrData.true_fcr_rate) : '—'} highlight="green" />
                    <StatCard label="FCR: True"           value={fcrData.fcr_true.toLocaleString()} highlight="green" />
                    <StatCard label="FCR: False / Pending" value={`${fcrData.fcr_false.toLocaleString()} / ${fcrData.fcr_pending.toLocaleString()}`} highlight="red" />
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    <Card>
                      <CardHeader><CardTitle>FCR by Intent Type</CardTitle></CardHeader>
                      <CardContent>
                        {fcrData.by_intent.length === 0 ? (
                          <EmptyState title="No intent breakdown yet" description="Requires resolved tickets with FCR checked." />
                        ) : (
                          <div className="overflow-x-auto">
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="border-b border-surface-border text-left text-subtle">
                                  <th className="py-2 px-3">Intent</th>
                                  <th className="py-2 px-3 text-right">Total</th>
                                  <th className="py-2 px-3 text-right">FCR True</th>
                                  <th className="py-2 px-3 text-right">FCR False</th>
                                  <th className="py-2 px-3 text-right">True FCR %</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-surface-border">
                                {fcrData.by_intent.map((row) => (
                                  <tr key={row.intent} className="hover:bg-surface-card/50">
                                    <td className="py-2 px-3 font-mono text-brand-400">{row.intent}</td>
                                    <td className="py-2 px-3 text-right">{row.total.toLocaleString()}</td>
                                    <td className="py-2 px-3 text-right text-green-400">{row.fcr_true.toLocaleString()}</td>
                                    <td className="py-2 px-3 text-right text-red-400">{row.fcr_false.toLocaleString()}</td>
                                    <td className="py-2 px-3 text-right font-mono">
                                      {row.true_fcr_rate != null
                                        ? <span className={row.true_fcr_rate < 0.6 ? 'text-red-400' : 'text-green-400'}>{formatPercent(row.true_fcr_rate)}</span>
                                        : '—'}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </CardContent>
                    </Card>

                    <Card>
                      <CardHeader><CardTitle>FCR Trend (daily)</CardTitle></CardHeader>
                      <CardContent>
                        {fcrData.trend.length === 0 ? (
                          <EmptyState title="No trend data yet" />
                        ) : (
                          <TrendLineChart
                            data={fcrData.trend as unknown as Record<string, unknown>[]}
                            lines={[
                              { key: 'checked',  name: 'Checked',  color: '#94a3b8' },
                              { key: 'fcr_true', name: 'FCR True', color: '#22c55e' },
                            ]}
                          />
                        )}
                      </CardContent>
                    </Card>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── Spike Reports ─────────────────────────────────────── */}
          {activeTab === 'spikes' && (
            <div className="space-y-4">
              {spikesLoading ? (
                <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24 w-full" />)}</div>
              ) : !spikesData || spikesData.items.length === 0 ? (
                <Card>
                  <CardContent>
                    <EmptyState
                      icon={<AlertTriangle className="w-10 h-10 text-subtle" />}
                      title={spikesData?.message ?? 'No spike reports yet'}
                      description="The spike detector runs every 15 minutes. Reports appear here when ticket volume exceeds 2σ above baseline."
                    />
                  </CardContent>
                </Card>
              ) : (
                <>
                  <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
                    <StatCard label="Total Spikes Detected" value={spikesData.total.toLocaleString()} highlight="red" />
                    <StatCard label="Most Recent Spike"     value={new Date(spikesData.items[0].window_start).toLocaleString()} />
                    <StatCard label="Peak σ Above Baseline" value={Math.max(...spikesData.items.map((s) => s.sigma_above)).toFixed(1) + 'σ'} highlight="red" />
                  </div>

                  <div className="space-y-3">
                    {spikesData.items.map((spike) => (
                      <Card key={spike.spike_id}>
                        <CardHeader>
                          <div className="flex items-center justify-between flex-wrap gap-2">
                            <CardTitle className="text-sm">
                              <Clock className="w-4 h-4 inline mr-1 text-amber-400" />
                              {new Date(spike.window_start).toLocaleString()} → {new Date(spike.window_end).toLocaleTimeString()}
                            </CardTitle>
                            <div className="flex gap-3 text-xs text-muted">
                              <span>Volume: <strong className="text-red-400">{spike.current_volume}</strong></span>
                              <span>Baseline: {spike.baseline_mean.toFixed(0)}</span>
                              <span className="text-amber-400 font-mono">{spike.sigma_above.toFixed(1)}σ</span>
                              <span className="text-subtle">{spike.cluster_method}</span>
                            </div>
                          </div>
                        </CardHeader>
                        <CardContent>
                          {spike.clusters_json.length === 0 ? (
                            <p className="text-xs text-muted">No cluster breakdown available.</p>
                          ) : (
                            <div className="overflow-x-auto">
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="border-b border-surface-border text-left text-subtle">
                                    <th className="py-1.5 px-3">Cluster</th>
                                    <th className="py-1.5 px-3 text-right">Count</th>
                                    <th className="py-1.5 px-3 text-right">%</th>
                                    <th className="py-1.5 px-3">Top Issue L1</th>
                                    <th className="py-1.5 px-3">Top Issue L2</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-surface-border">
                                  {spike.clusters_json.map((c, ci) => (
                                    <tr key={ci} className="hover:bg-surface-card/50">
                                      <td className="py-1.5 px-3 font-medium">{c.name}</td>
                                      <td className="py-1.5 px-3 text-right font-mono">{c.count}</td>
                                      <td className="py-1.5 px-3 text-right font-mono text-amber-400">{c.percentage.toFixed(1)}%</td>
                                      <td className="py-1.5 px-3 text-brand-400">{c.top_issue_l1}</td>
                                      <td className="py-1.5 px-3 text-muted">{c.top_issue_l2}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── Agent Quality ─────────────────────────────────────── */}
          {activeTab === 'agent_quality' && (
            <div className="space-y-4">
              {aqLoading ? (
                <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24 w-full" />)}</div>
              ) : !aqData ? (
                <Card><CardContent><EmptyState icon={<AlertTriangle className="w-10 h-10 text-subtle" />} title="No agent quality data" description="Agent QA scoring runs every 5 minutes against closed conversations." /></CardContent></Card>
              ) : (
                <>
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                    <StatCard label="QA Coverage"            value={formatPercent(aqData.coverage)}                             highlight={aqData.coverage > 0.8 ? 'green' : 'amber'} />
                    <StatCard label="Total Conversations"    value={aqData.total_conversations.toLocaleString()} />
                    <StatCard label="Total Scored"           value={aqData.total_scored.toLocaleString()} />
                    <StatCard label="Active Flags"           value={aqData.total_flags.toLocaleString()}                        highlight={aqData.total_flags > 0 ? 'red' : 'green'} />
                  </div>

                  {/* Filter */}
                  <div className="flex gap-3 items-center">
                    <Select
                      options={[
                        { value: '',      label: 'All Flags' },
                        { value: 'false', label: 'Unresolved' },
                        { value: 'true',  label: 'Resolved' },
                      ]}
                      value={aqResolved}
                      onChange={(e) => { setAqResolved(e.target.value); setAqPage(1) }}
                    />
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    {/* Agent flags */}
                    <Card>
                      <CardHeader>
                        <CardTitle>Agent Flags  <span className="text-xs font-normal text-subtle ml-2">policy-ineligible refund rate alerts</span></CardTitle>
                      </CardHeader>
                      <CardContent className="p-0">
                        {aqData.flags.length === 0 ? (
                          <div className="p-4"><EmptyState title="No flags" description="No agents flagged under current filter." /></div>
                        ) : (
                          <>
                            <div className="overflow-x-auto">
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="border-b border-surface-border text-left text-subtle">
                                    <th className="py-2 px-3">Agent ID</th>
                                    <th className="py-2 px-3">Flagged At</th>
                                    <th className="py-2 px-3 text-right">Tickets</th>
                                    <th className="py-2 px-3 text-right">Refund Rate</th>
                                    <th className="py-2 px-3 text-right">Manual Rev.</th>
                                    <th className="py-2 px-3">Reason</th>
                                    <th className="py-2 px-3">Status</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-surface-border">
                                  {aqData.flags.map((f) => (
                                    <tr key={`${f.agent_id}-${f.flagged_at}`} className="hover:bg-surface-card/50">
                                      <td className="py-2 px-3 font-mono text-brand-400">{f.agent_id}</td>
                                      <td className="py-2 px-3 text-muted">{new Date(f.flagged_at).toLocaleDateString()}</td>
                                      <td className="py-2 px-3 text-right">{f.total_tickets}</td>
                                      <td className="py-2 px-3 text-right">
                                        <span className={f.refund_rate > 0.35 ? 'text-red-400 font-mono' : 'font-mono'}>{formatPercent(f.refund_rate)}</span>
                                      </td>
                                      <td className="py-2 px-3 text-right">{f.manual_review_count}</td>
                                      <td className="py-2 px-3 text-muted text-[11px]">{f.flag_reason}</td>
                                      <td className="py-2 px-3">
                                        {f.resolved
                                          ? <span className="text-green-400">Resolved</span>
                                          : <span className="text-red-400">Open</span>}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                            {aqData.total_pages > 1 && (
                              <PaginationBar page={aqPage} totalPages={aqData.total_pages} onPageChange={setAqPage} total={aqData.total_flags} pageSize={50} />
                            )}
                          </>
                        )}
                      </CardContent>
                    </Card>

                    {/* Per-agent QA scores */}
                    <Card>
                      <CardHeader>
                        <CardTitle>Per-Agent QA Scores  <span className="text-xs font-normal text-subtle ml-2">conversation quality</span></CardTitle>
                      </CardHeader>
                      <CardContent className="p-0">
                        {aqData.qa_summary.length === 0 ? (
                          <div className="p-4"><EmptyState title="No QA scores yet" description="Scores will appear after the QA scorer processes closed conversations." /></div>
                        ) : (
                          <div className="overflow-x-auto">
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="border-b border-surface-border text-left text-subtle">
                                  <th className="py-2 px-3">Agent ID</th>
                                  <th className="py-2 px-3 text-right">Scored</th>
                                  <th className="py-2 px-3 text-right">Avg QA</th>
                                  <th className="py-2 px-3 text-right">Canned Ratio</th>
                                  <th className="py-2 px-3 text-right">Grammar Err</th>
                                  <th className="py-2 px-3 text-right">Flagged</th>
                                  <th className="py-2 px-3">Last Scored</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-surface-border">
                                {aqData.qa_summary.map((s) => (
                                  <tr key={s.agent_id} className="hover:bg-surface-card/50">
                                    <td className="py-2 px-3 font-mono text-brand-400">{s.agent_id}</td>
                                    <td className="py-2 px-3 text-right">{s.total_scored}</td>
                                    <td className="py-2 px-3 text-right">
                                      <span className={s.avg_qa_score < 0.5 ? 'text-red-400 font-mono' : s.avg_qa_score > 0.75 ? 'text-green-400 font-mono' : 'font-mono'}>
                                        {formatPercent(s.avg_qa_score)}
                                      </span>
                                    </td>
                                    <td className="py-2 px-3 text-right">
                                      <span className={s.avg_canned_ratio > 0.4 ? 'text-amber-400 font-mono' : 'font-mono'}>{formatPercent(s.avg_canned_ratio)}</span>
                                    </td>
                                    <td className="py-2 px-3 text-right font-mono">{s.avg_grammar_errors.toFixed(1)}</td>
                                    <td className="py-2 px-3 text-right">
                                      {s.flagged_count > 0 ? <span className="text-red-400">{s.flagged_count}</span> : <span className="text-green-400">0</span>}
                                    </td>
                                    <td className="py-2 px-3 text-muted">{new Date(s.last_scored_at).toLocaleDateString()}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── Evaluation Matrix ────────────────────────────────── */}
          {activeTab === 'evaluations' && (
            <div className="space-y-4">

              {/* ── Per-page derived stat cards ── */}
              {pageStats && (
                <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
                  <StatCard label="Std Logic Pass (pg)" value={formatPercent(pageStats.stdLogicRate)}   highlight="green" />
                  <StatCard label="Greedy Rate (pg)"    value={formatPercent(pageStats.greedyRate)}     highlight={pageStats.greedyRate > 0.2 ? 'red' : 'green'} />
                  <StatCard label="Discrepancy (pg)"    value={formatPercent(pageStats.discrepancyRate)} highlight={pageStats.discrepancyRate > 0.1 ? 'red' : 'green'} />
                  <StatCard label="Override Rate (pg)"  value={formatPercent(pageStats.overrideRate)}   highlight={pageStats.overrideRate > 0.1 ? 'amber' : 'green'} />
                  <StatCard label="Avg Confidence (pg)" value={pageStats.avgConfidence != null ? formatPercent(pageStats.avgConfidence) : '—'} highlight="green" />
                </div>
              )}

              {/* ── Filter panel ── */}
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle>Filters  <span className="text-xs font-normal text-subtle ml-2">— any combination of evaluated columns</span></CardTitle>
                    {activeFilters.length > 0 && (
                      <Button variant="ghost" size="sm" onClick={clearAllFilters} className="text-xs text-muted hover:text-foreground">
                        Clear all
                      </Button>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-2">
                    <Select options={makeOptions(evaluationFilters?.modules,              'All Modules')}    value={evalModule}               onChange={(e) => { setEvalModule(e.target.value);               setEvalPage(1) }} />
                    <Select options={makeOptions(evaluationFilters?.issue_l1,             'All Issue L1')}   value={evalIssueL1}              onChange={(e) => { setEvalIssueL1(e.target.value);              setEvalPage(1) }} />
                    <Select options={makeOptions(evaluationFilters?.issue_l2,             'All Issue L2')}   value={evalIssueL2}              onChange={(e) => { setEvalIssueL2(e.target.value);              setEvalPage(1) }} />
                    <Select options={makeOptions(evaluationFilters?.fraud_segments,       'All Fraud Segs')} value={evalFraudSegment}         onChange={(e) => { setEvalFraudSegment(e.target.value);         setEvalPage(1) }} />
                    <Select options={makeOptions(evaluationFilters?.value_segments,       'All Value Segs')} value={evalValueSegment}         onChange={(e) => { setEvalValueSegment(e.target.value);         setEvalPage(1) }} />
                    <Select options={makeOptions(evaluationFilters?.action_codes,         'All Actions')}    value={evalActionCode}           onChange={(e) => { setEvalActionCode(e.target.value);           setEvalPage(1) }} />
                    <Select options={makeOptions(evaluationFilters?.automation_pathways,  'All Pathways')}   value={evalAutomationPathway}    onChange={(e) => { setEvalAutomationPathway(e.target.value);    setEvalPage(1) }} />
                    <Select options={makeOptions(evaluationFilters?.greedy_classifications,'All Greedy')}    value={evalGreedyClassification} onChange={(e) => { setEvalGreedyClassification(e.target.value); setEvalPage(1) }} />
                    <Select options={makeOptions(evaluationFilters?.pipeline_stages,      'All P. Stages')}  value={evalPipelineStage}        onChange={(e) => { setEvalPipelineStage(e.target.value);        setEvalPage(1) }} />
                    <Select
                      options={[
                        { value: '', label: 'Std Logic (All)' },
                        { value: 'true',  label: 'Std Logic: Pass' },
                        { value: 'false', label: 'Std Logic: Fail' },
                      ]}
                      value={evalStandardLogic}
                      onChange={(e) => { setEvalStandardLogic(e.target.value); setEvalPage(1) }}
                    />
                    <Select
                      options={[
                        { value: '', label: 'Override (All)' },
                        { value: 'true',  label: 'Override: Yes' },
                        { value: 'false', label: 'Override: No' },
                      ]}
                      value={evalOverrideApplied}
                      onChange={(e) => { setEvalOverrideApplied(e.target.value); setEvalPage(1) }}
                    />
                  </div>

                  {/* Active filter chips */}
                  {activeFilters.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {activeFilters.map((f) => (
                        <FilterChip key={f.label} label={f.label} value={f.value} onRemove={f.clear} />
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* ── Evaluation Matrix table ── */}
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle>Evaluated Columns — Source → Evaluation → Validation</CardTitle>
                    {evaluationData && (
                      <span className="text-xs text-subtle">{evaluationData.total.toLocaleString()} rows</span>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="p-0">
                  {evaluationLoading ? (
                    <div className="p-4 space-y-2">
                      {Array.from({ length: 10 }).map((_, i) => (
                        <Skeleton key={i} className="h-8 w-full" />
                      ))}
                    </div>
                  ) : !evaluationData?.items?.length ? (
                    <div className="p-6">
                      <EmptyState
                        title="No evaluation rows found"
                        description="Adjust filters or run the pipeline to populate evaluation data. The endpoint GET /analytics/evaluations must return rows from llm_output_2 joined with llm_output_3."
                      />
                    </div>
                  ) : (
                    <>
                      <div className="overflow-x-auto">
                        <table className="min-w-[2200px] w-full text-xs">
                          <thead>
                            {/* ── Group header row ── */}
                            <tr className="border-b border-surface-border">
                              {COL_GROUPS.map((g) => (
                                <th
                                  key={g.label}
                                  colSpan={g.span}
                                  className={cn(
                                    'py-1.5 px-3 text-left text-xs font-semibold uppercase tracking-wider',
                                    g.className,
                                    g.borderClass,
                                  )}
                                >
                                  {g.label}
                                </th>
                              ))}
                            </tr>
                            {/* ── Individual column header row ── */}
                            <tr className="border-b border-surface-border bg-surface-card/30">
                              {COLUMN_DEFS.map((col, ci) => {
                                const group = COL_GROUPS[col.group]
                                // Add left border at group boundaries
                                const isFirstInGroup = ci === 0 || COLUMN_DEFS[ci - 1].group !== col.group
                                return (
                                  <th
                                    key={col.label}
                                    className={cn(
                                      'px-3 py-2 text-left font-medium text-subtle uppercase tracking-wider whitespace-nowrap',
                                      isFirstInGroup && col.group > 0 && group.borderClass,
                                    )}
                                  >
                                    {col.label}
                                  </th>
                                )
                              })}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-surface-border">
                            {evaluationData.items.map((row) => (
                              <tr key={`${row.ticket_id}-${row.order_id}`} className="hover:bg-surface-card/50 transition-colors">
                                {COLUMN_DEFS.map((col, ci) => {
                                  const group = COL_GROUPS[col.group]
                                  const isFirstInGroup = ci === 0 || COLUMN_DEFS[ci - 1].group !== col.group
                                  return (
                                    <td
                                      key={col.label}
                                      className={cn(
                                        'px-3 py-2 text-foreground whitespace-nowrap',
                                        isFirstInGroup && col.group > 0 && group.borderClass,
                                      )}
                                    >
                                      {col.render(row)}
                                    </td>
                                  )
                                })}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      {evaluationData.total_pages > 1 && (
                        <PaginationBar
                          page={evalPage}
                          totalPages={evaluationData.total_pages}
                          onPageChange={setEvalPage}
                          total={evaluationData.total}
                          pageSize={PAGE_SIZE}
                        />
                      )}
                    </>
                  )}
                </CardContent>
              </Card>
            </div>
          )}
        </>
      )}
    </div>
  )
}
