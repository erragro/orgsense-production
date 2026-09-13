import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Badge } from '@/components/ui/Badge'
import { StatusPill } from '@/components/common/StatusPill'
import { VersionBadge } from '@/components/common/VersionBadge'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { EmptyState } from '@/components/common/EmptyState'
import { JsonViewer } from '@/components/common/JsonViewer'
import { kbApi } from '@/api/governance/kb.api'
import { simulationApi } from '@/api/governance/simulation.api'
import { shadowApi } from '@/api/governance/shadow.api'
import { toast } from '@/stores/toast.store'
import { useAuthStore } from '@/stores/auth.store'
import { hasPermission } from '@/lib/access'
import { formatDate } from '@/lib/dates'
import { cn } from '@/lib/cn'
import { Shield, Play, Ghost, BookOpen, Search, CheckCircle2, Zap, ArrowRight, AlertTriangle, RefreshCw, Brain, GitCompare, Cpu, MessageSquare } from 'lucide-react'

type Tab = 'versions' | 'simulation' | 'shadow'

export default function PolicyPage() {
  const [activeTab, setActiveTab] = useState<Tab>('versions')
  const { user } = useAuthStore()
  const canPublish = !!(user?.is_super_admin || hasPermission(user, 'policy', 'admin'))

  const { data: versions } = useQuery({
    queryKey: ['kb', 'versions'],
    queryFn: () => kbApi.getVersions().then((r) => r.data),
  })

  const { data: activeVersion } = useQuery({
    queryKey: ['kb', 'active-version'],
    queryFn: () => kbApi.getActiveVersion().then((r) => r.data),
  })

  const TABS = [
    { key: 'versions' as const, label: 'Versions', icon: BookOpen },
    { key: 'simulation' as const, label: 'Simulation', icon: Play },
    { key: 'shadow' as const, label: 'Shadow Policy', icon: Ghost },
  ]

  return (
    <div>
      <PageHeader
        title="Policy Management"
        subtitle="Compare policy versions, run simulations, and manage shadow testing"
        actions={activeVersion && <VersionBadge version={activeVersion.active_version} isActive />}
      />

      <div className="flex gap-1 mb-4 border-b border-surface-border">
        {TABS.map((tab) => (
          <button key={tab.key} onClick={() => setActiveTab(tab.key)}
            className={cn('flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors',
              activeTab === tab.key ? 'border-brand-500 text-brand-400' : 'border-transparent text-muted hover:text-foreground')}>
            <tab.icon className="w-3.5 h-3.5" />{tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'versions' && (
        <PolicyVersionsPanel versions={versions} activeVersion={activeVersion?.active_version} />
      )}
      {activeTab === 'simulation' && (
        <SimulationPanel versions={versions?.map((v) => v.version_label) ?? []} canEdit={!!(user?.is_super_admin || hasPermission(user, 'policy', 'edit'))} />
      )}
      {activeTab === 'shadow' && (
        <ShadowPolicyPanel canPublish={canPublish} />
      )}
    </div>
  )
}

function PolicyVersionsPanel({ versions, activeVersion }: {
  versions?: Array<{ id: number; version_label: string; status: string; created_by: string | null; created_at: string }>
  activeVersion?: string
}) {
  const [viewingVersion, setViewingVersion] = useState<string | null>(null)

  const { data: snapshot } = useQuery({
    queryKey: ['kb', 'version', viewingVersion],
    queryFn: () => kbApi.getVersion(viewingVersion!).then((r) => r.data),
    enabled: viewingVersion != null,
  })

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div className="lg:col-span-2">
        <Card>
          <CardHeader><CardTitle>Policy Versions</CardTitle></CardHeader>
          <CardContent className="p-0">
            {!versions?.length ? (
              <EmptyState title="No versions" />
            ) : (
              <div className="divide-y divide-surface-border">
                {versions.map((v) => (
                  <div key={v.id} className="flex items-center gap-4 px-4 py-3">
                    <VersionBadge version={v.version_label} isActive={v.version_label === activeVersion} />
                    <StatusPill status={v.status} />
                    <span className="text-xs text-subtle flex-1">{v.created_by ?? '—'}</span>
                    <span className="text-xs text-subtle">{formatDate(v.created_at)}</span>
                    <Button variant="ghost" size="xs" onClick={() => setViewingVersion(v.version_label)}>View Snapshot</Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div>
        {viewingVersion && snapshot ? (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Snapshot: {viewingVersion}</CardTitle>
                <Button variant="ghost" size="xs" onClick={() => setViewingVersion(null)}>✕</Button>
              </div>
            </CardHeader>
            <CardContent>
              <JsonViewer data={snapshot} expanded={false} />
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent>
              <EmptyState icon={<Shield className="w-8 h-8 text-subtle" />} title="Select a version" description="Click 'View Snapshot' to inspect a version's content." />
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}

// ─── types ────────────────────────────────────────────────────────────────────
interface SimTicket {
  ticket_id: number; subject: string | null; module: string | null
  issue_type_l1: string | null; issue_type_l2: string | null
  order_value: number | null; fraud_segment: string | null
  value_segment: string | null; greedy_classification: string | null
  sla_breach: boolean | null; final_action_code: string | null
  final_refund_amount: number | null; evaluated_on_version: string | null
  cx_email: string | null; automation_pathway: string | null
}

interface CardinalStage1 {
  action_code: string | null
  calculated_gratification: number | null
  fraud_segment: string | null
  greedy_classification: string | null
  greedy_signals_count: number | null
  sla_breach: boolean | null
  order_value: number | null
  overall_confidence: number | null
  standard_logic_passed: boolean | null
  reasoning: string | null
  error: string | null
}

interface CardinalStage2 {
  final_action_code: string | null
  final_refund_amount: number
  automation_pathway: string
  discrepancy_detected: boolean | null
  discrepancy_details: string | null
  override_applied: boolean | null
  override_reason: string | null
  validation_status: string | null
  reasoning: string | null
  error: string | null
}

interface CardinalStage3 {
  response_draft: string
  hitl_queue: string | null
  action_code: string | null
  refund_amount: number | null
}

interface CardinalVersionEval {
  version: string
  stage1: CardinalStage1
  stage2: CardinalStage2
  stage3: CardinalStage3 | null
  automation_pathway: string
  final_action_code: string | null
  final_refund_amount: number
  rules_count: number
}

interface CardinalSimResult {
  ticket: SimTicket
  ticket_context: Record<string, unknown>
  stage0: {
    issue_type_l1: string | null
    issue_type_l2: string | null
    confidence: number | null
    image_required: boolean | null
    reasoning: string | null
  }
  baseline: CardinalVersionEval
  candidate: CardinalVersionEval
  comparison: {
    decision_changed: boolean
    pathway_changed: boolean
    refund_changed: boolean
    final_action_baseline: string | null
    final_action_candidate: string | null
    pathway_baseline: string
    pathway_candidate: string
    refund_baseline: number
    refund_candidate: number
    stage1_action_changed: boolean
    stage1_action_baseline: string | null
    stage1_action_candidate: string | null
    greedy_changed: boolean
    greedy_baseline: string | null
    greedy_candidate: string | null
    rules_baseline: number
    rules_candidate: number
  }
}

interface TicketRow {
  ticket_id: number; subject: string | null; module: string | null
  issue_type_l1: string | null; final_action_code: string | null
  automation_pathway: string | null; created_at: string
}

// ─── helpers ──────────────────────────────────────────────────────────────────
function pathwayColor(p: string) {
  if (p === 'AUTO_RESOLVED') return 'text-green-400'
  if (p === 'HITL') return 'text-amber-400'
  return 'text-red-400'
}

function confidencePct(v: number | null) {
  if (v == null) return '—'
  return `${(v * 100).toFixed(0)}%`
}

function SimulationPanel({ versions, canEdit }: { versions: string[]; canEdit: boolean }) {
  const [ticketSearch, setTicketSearch] = useState('')
  const [selectedTicket, setSelectedTicket] = useState<SimTicket | null>(null)
  const [baseline, setBaseline] = useState('')
  const [candidate, setCandidate] = useState('')
  const [result, setResult] = useState<CardinalSimResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [expandedReasoning, setExpandedReasoning] = useState<Record<string, boolean>>({})

  const { data: tickets, isFetching: searchLoading } = useQuery({
    queryKey: ['sim-tickets', ticketSearch],
    queryFn: () => simulationApi.listTickets({ search: ticketSearch || undefined, limit: 20 }).then(r => r.data as TicketRow[]),
    enabled: true,
  })

  const handleSelectTicket = async (row: TicketRow) => {
    try {
      const res = await simulationApi.getTicket(row.ticket_id)
      setSelectedTicket(res.data as SimTicket)
      setResult(null)
    } catch {
      toast.error('Failed to load ticket')
    }
  }

  const handleRun = async () => {
    if (!selectedTicket || !baseline || !candidate) return
    setLoading(true)
    setResult(null)
    try {
      const res = await simulationApi.runTicketCardinal({
        ticket_id: selectedTicket.ticket_id,
        baseline_version: baseline,
        candidate_version: candidate,
      })
      setResult(res.data as CardinalSimResult)
      toast.success('Cardinal simulation complete')
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      toast.error(msg || 'Simulation failed')
    } finally {
      setLoading(false)
    }
  }

  const toggleReasoning = (key: string) =>
    setExpandedReasoning(prev => ({ ...prev, [key]: !prev[key] }))

  if (!canEdit) {
    return (
      <Card><CardContent className="py-8 text-center text-sm text-muted">
        Editor or Publisher role required to run simulations.
      </CardContent></Card>
    )
  }

  return (
    <div className="space-y-4">
      {/* ── Step 1: Ticket picker ─────────────────────────── */}
      <Card>
        <CardHeader><CardTitle className="text-sm flex items-center gap-2"><Search className="w-4 h-4" />Step 1 — Select Ticket</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input
              placeholder="Search by subject or ticket ID…"
              value={ticketSearch}
              onChange={e => setTicketSearch(e.target.value)}
              className="flex-1"
            />
            {searchLoading && <span className="text-xs text-subtle self-center">loading…</span>}
          </div>
          {tickets && tickets.length > 0 && (
            <div className="max-h-48 overflow-y-auto divide-y divide-surface-border border border-surface-border rounded-md">
              {tickets.map(t => (
                <button
                  key={t.ticket_id}
                  onClick={() => handleSelectTicket(t)}
                  className={cn(
                    'w-full text-left px-3 py-2 text-sm flex items-center gap-3 hover:bg-surface/60 transition-colors',
                    selectedTicket?.ticket_id === t.ticket_id && 'bg-brand-600/10 border-l-2 border-brand-500',
                  )}
                >
                  <span className="font-mono text-xs text-subtle w-16 shrink-0">#{t.ticket_id}</span>
                  <span className="flex-1 truncate text-foreground">{t.subject ?? '(no subject)'}</span>
                  <span className="text-xs text-subtle shrink-0">{t.module}</span>
                  {t.final_action_code && (
                    <span className="text-xs font-mono bg-surface px-1.5 py-0.5 rounded shrink-0">{t.final_action_code}</span>
                  )}
                </button>
              ))}
            </div>
          )}
          {tickets?.length === 0 && <p className="text-xs text-subtle">No tickets found.</p>}
          {selectedTicket && (
            <div className="rounded-md border border-brand-700/40 bg-brand-600/5 p-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <div><span className="text-subtle block">Ticket</span><span className="font-mono">#{selectedTicket.ticket_id}</span></div>
              <div><span className="text-subtle block">Issue</span><span>{selectedTicket.issue_type_l1 ?? selectedTicket.module ?? '—'}</span></div>
              <div><span className="text-subtle block">Order Value</span><span>{selectedTicket.order_value != null ? `₹${Number(selectedTicket.order_value).toLocaleString('en-IN')}` : '—'}</span></div>
              <div><span className="text-subtle block">Existing Decision</span><span className="font-mono">{selectedTicket.final_action_code ?? '—'}</span></div>
              <div><span className="text-subtle block">Fraud Segment</span><span>{selectedTicket.fraud_segment ?? '—'}</span></div>
              <div><span className="text-subtle block">SLA Breach</span><span>{selectedTicket.sla_breach ? 'Yes' : 'No'}</span></div>
              <div><span className="text-subtle block">Pathway</span><span>{selectedTicket.automation_pathway ?? '—'}</span></div>
              <div><span className="text-subtle block">Evaluated On</span><span className="font-mono">{selectedTicket.evaluated_on_version ?? '—'}</span></div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Step 2: Version selectors + Run ──────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Play className="w-4 h-4" />Step 2 — Select Versions & Run Cardinal Pipeline
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="p-2.5 rounded-md bg-brand-600/5 border border-brand-700/30 text-xs text-muted flex items-start gap-2">
            <Brain className="w-3.5 h-3.5 mt-0.5 text-brand-400 shrink-0" />
            <span>Runs the full 4-stage Cardinal pipeline for each version: Stage 0 (gpt-4o-mini classification) → Stage 1 (gpt-4.1 LLM evaluation + Weaviate rule candidates) → Stage 2 (deterministic validation) → Stage 3 (HITL response draft if applicable). Stage 0 runs once; Stages 1–3 run per version.</span>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-muted mb-1 block">Baseline Version</label>
              <select className="w-full bg-surface border border-surface-border rounded-md px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-brand-500"
                value={baseline} onChange={e => setBaseline(e.target.value)}>
                <option value="">Select baseline…</option>
                {versions.map(v => <option key={v} value={v}>{v}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-muted mb-1 block">Candidate Version</label>
              <select className="w-full bg-surface border border-surface-border rounded-md px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-brand-500"
                value={candidate} onChange={e => setCandidate(e.target.value)}>
                <option value="">Select candidate…</option>
                {versions.map(v => <option key={v} value={v}>{v}</option>)}
              </select>
            </div>
          </div>
          <Button
            onClick={handleRun}
            loading={loading}
            disabled={!selectedTicket || !baseline || !candidate || baseline === candidate}
            className="w-full"
          >
            <Zap className="w-4 h-4 mr-1" />{loading ? 'Running Cardinal Pipeline…' : 'Run Cardinal Simulation'}
          </Button>
          {loading && (
            <p className="text-xs text-subtle text-center">LLM calls in progress — this may take 10–20s per version…</p>
          )}
          {!selectedTicket && <p className="text-xs text-subtle text-center">Select a ticket first.</p>}
          {selectedTicket && baseline && candidate && baseline === candidate && (
            <p className="text-xs text-amber-400 text-center">Baseline and candidate must differ.</p>
          )}
        </CardContent>
      </Card>

      {/* ── Results ──────────────────────────────────────── */}
      {result && (
        <>
          {/* ── Stage 0 — shared classification ─────────── */}
          <Card className="border-brand-700/30">
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2">
                <Brain className="w-4 h-4 text-brand-400" />
                Stage 0 — Classification <Badge variant="gray" size="sm">shared · gpt-4o-mini</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                <div><span className="text-subtle block">Issue L1</span><span className="font-semibold">{result.stage0.issue_type_l1 ?? '—'}</span></div>
                <div><span className="text-subtle block">Issue L2</span><span className="font-semibold">{result.stage0.issue_type_l2 ?? '—'}</span></div>
                <div><span className="text-subtle block">Confidence</span><span className="font-semibold text-brand-300">{confidencePct(result.stage0.confidence)}</span></div>
                <div><span className="text-subtle block">Image Required</span><span>{result.stage0.image_required ? 'Yes' : 'No'}</span></div>
              </div>
              {result.stage0.reasoning && (
                <p className="text-xs text-muted mt-2 italic">"{result.stage0.reasoning}"</p>
              )}
            </CardContent>
          </Card>

          {/* ── Decision changed banner ───────────────────── */}
          <Card className={cn('border-2', result.comparison.decision_changed ? 'border-amber-700/50 bg-amber-900/5' : 'border-green-700/40 bg-green-900/5')}>
            <CardContent className="py-4">
              <div className="flex items-center gap-3 flex-wrap">
                {result.comparison.decision_changed
                  ? <AlertTriangle className="w-5 h-5 text-amber-400" />
                  : <CheckCircle2 className="w-5 h-5 text-green-400" />}
                <span className="font-semibold text-sm">
                  {result.comparison.decision_changed ? 'Final decision changed between versions' : 'Same final decision in both versions'}
                </span>
                <div className="flex items-center gap-2 ml-auto text-sm">
                  <span className="font-mono bg-surface px-2 py-0.5 rounded text-xs">{result.comparison.final_action_baseline ?? 'NONE'}</span>
                  <ArrowRight className="w-3.5 h-3.5 text-subtle" />
                  <span className={cn('font-mono px-2 py-0.5 rounded text-xs', result.comparison.decision_changed ? 'bg-amber-900/40 text-amber-300' : 'bg-surface')}>
                    {result.comparison.final_action_candidate ?? 'NONE'}
                  </span>
                </div>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3 text-xs">
                <div>
                  <span className="text-subtle block">Pathway baseline</span>
                  <span className={cn('font-semibold', pathwayColor(result.comparison.pathway_baseline))}>{result.comparison.pathway_baseline}</span>
                </div>
                <div>
                  <span className="text-subtle block">Pathway candidate</span>
                  <span className={cn('font-semibold', pathwayColor(result.comparison.pathway_candidate))}>{result.comparison.pathway_candidate}</span>
                </div>
                <div>
                  <span className="text-subtle block">Refund baseline</span>
                  <span className="font-semibold">₹{result.comparison.refund_baseline.toLocaleString('en-IN')}</span>
                </div>
                <div>
                  <span className="text-subtle block">Refund candidate</span>
                  <span className={cn('font-semibold', result.comparison.refund_changed ? 'text-amber-400' : '')}>
                    ₹{result.comparison.refund_candidate.toLocaleString('en-IN')}
                  </span>
                </div>
              </div>
              {(result.comparison.stage1_action_changed || result.comparison.greedy_changed) && (
                <div className="mt-3 pt-3 border-t border-surface-border grid grid-cols-2 gap-3 text-xs">
                  {result.comparison.stage1_action_changed && (
                    <div>
                      <span className="text-subtle block">LLM action (Stage 1)</span>
                      <span className="font-mono">{result.comparison.stage1_action_baseline}</span>
                      <ArrowRight className="w-3 h-3 inline mx-1 text-subtle" />
                      <span className="font-mono text-amber-300">{result.comparison.stage1_action_candidate}</span>
                    </div>
                  )}
                  {result.comparison.greedy_changed && (
                    <div>
                      <span className="text-subtle block">Greedy classification</span>
                      <span className="font-mono">{result.comparison.greedy_baseline}</span>
                      <ArrowRight className="w-3 h-3 inline mx-1 text-subtle" />
                      <span className="font-mono text-amber-300">{result.comparison.greedy_candidate}</span>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* ── Stage 1 + 2 side-by-side ─────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {(['baseline', 'candidate'] as const).map(side => {
              const ev = result[side]
              const s1 = ev.stage1
              const s2 = ev.stage2
              const s3 = ev.stage3
              const isBaseline = side === 'baseline'
              const colorClass = isBaseline ? 'text-blue-300 bg-blue-900/40' : 'text-purple-300 bg-purple-900/40'
              const r1Key = `${side}-s1`
              const r2Key = `${side}-s2`

              return (
                <div key={side} className="space-y-3">
                  <div className={cn('inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-mono', colorClass)}>
                    {isBaseline ? 'Baseline' : 'Candidate'}: {ev.version}
                    <span className="opacity-60 ml-1">({ev.rules_count} rules)</span>
                  </div>

                  {/* Stage 1 — LLM evaluation */}
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-xs flex items-center gap-1.5 text-muted">
                        <Cpu className="w-3.5 h-3.5" />Stage 1 — LLM Evaluation
                        <Badge variant="gray" size="sm">gpt-4.1 + Weaviate</Badge>
                        {s1.error && <Badge variant="red" size="sm">error</Badge>}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div><span className="text-subtle block">LLM Action</span><span className="font-mono font-semibold">{s1.action_code ?? '—'}</span></div>
                        <div><span className="text-subtle block">Confidence</span><span className="font-semibold text-brand-300">{confidencePct(s1.overall_confidence)}</span></div>
                        <div><span className="text-subtle block">Fraud Segment</span><span>{s1.fraud_segment ?? '—'}</span></div>
                        <div>
                          <span className="text-subtle block">Greedy</span>
                          <span className={cn('font-semibold', s1.greedy_classification === 'FRAUD' ? 'text-red-400' : s1.greedy_classification === 'SUSPICIOUS' ? 'text-amber-400' : 'text-green-400')}>
                            {s1.greedy_classification ?? '—'}
                          </span>
                        </div>
                        <div><span className="text-subtle block">Greedy Signals</span><span>{s1.greedy_signals_count ?? 0}</span></div>
                        <div><span className="text-subtle block">Refund Calc</span><span>₹{(s1.calculated_gratification ?? 0).toLocaleString('en-IN')}</span></div>
                        <div><span className="text-subtle block">SLA Breach</span><span>{s1.sla_breach ? 'Yes' : 'No'}</span></div>
                        <div><span className="text-subtle block">Standard Logic</span>
                          <span className={s1.standard_logic_passed ? 'text-green-400' : 'text-red-400'}>
                            {s1.standard_logic_passed == null ? '—' : s1.standard_logic_passed ? 'Pass' : 'Fail'}
                          </span>
                        </div>
                      </div>
                      {s1.reasoning && (
                        <div>
                          <button onClick={() => toggleReasoning(r1Key)} className="text-xs text-brand-400 hover:underline">
                            {expandedReasoning[r1Key] ? '▲ Hide' : '▼ Show'} LLM reasoning
                          </button>
                          {expandedReasoning[r1Key] && (
                            <p className="text-xs text-muted mt-1 p-2 bg-surface/40 rounded border border-surface-border whitespace-pre-wrap">{s1.reasoning}</p>
                          )}
                        </div>
                      )}
                      {s1.error && <p className="text-xs text-red-400 mt-1">Error: {s1.error}</p>}
                    </CardContent>
                  </Card>

                  {/* Stage 2 — deterministic validation */}
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-xs flex items-center gap-1.5 text-muted">
                        <GitCompare className="w-3.5 h-3.5" />Stage 2 — Deterministic Validation
                        <Badge variant="gray" size="sm">no LLM</Badge>
                        {s2.error && <Badge variant="red" size="sm">error</Badge>}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      <div className={cn('flex items-center gap-2 p-2 rounded-md border', s2.automation_pathway === 'AUTO_RESOLVED' ? 'border-green-700/40 bg-green-900/10' : s2.automation_pathway === 'HITL' ? 'border-amber-700/40 bg-amber-900/10' : 'border-red-700/40 bg-red-900/10')}>
                        <Zap className="w-4 h-4 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <span className="font-mono text-sm font-bold">{s2.final_action_code ?? 'UNKNOWN'}</span>
                          <span className={cn('ml-2 text-xs font-semibold', pathwayColor(s2.automation_pathway))}>{s2.automation_pathway}</span>
                        </div>
                        <span className="text-xs text-muted shrink-0">₹{s2.final_refund_amount.toLocaleString('en-IN')}</span>
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div><span className="text-subtle block">Validation Status</span><span>{s2.validation_status ?? '—'}</span></div>
                        <div>
                          <span className="text-subtle block">Discrepancy</span>
                          <span className={s2.discrepancy_detected ? 'text-amber-400' : ''}>{s2.discrepancy_detected ? 'Detected' : 'None'}</span>
                        </div>
                        {s2.override_applied && (
                          <div className="col-span-2">
                            <span className="text-subtle block">Override</span>
                            <span className="text-amber-300">{s2.override_reason ?? 'applied'}</span>
                          </div>
                        )}
                      </div>
                      {s2.discrepancy_details && (
                        <p className="text-xs text-amber-400 italic">{s2.discrepancy_details}</p>
                      )}
                      {s2.reasoning && (
                        <div>
                          <button onClick={() => toggleReasoning(r2Key)} className="text-xs text-brand-400 hover:underline">
                            {expandedReasoning[r2Key] ? '▲ Hide' : '▼ Show'} reasoning
                          </button>
                          {expandedReasoning[r2Key] && (
                            <p className="text-xs text-muted mt-1 p-2 bg-surface/40 rounded border border-surface-border whitespace-pre-wrap">{s2.reasoning}</p>
                          )}
                        </div>
                      )}
                      {s2.error && <p className="text-xs text-red-400 mt-1">Error: {s2.error}</p>}
                    </CardContent>
                  </Card>

                  {/* Stage 3 — HITL response draft */}
                  {s3 && (
                    <Card className="border-amber-700/30">
                      <CardHeader className="pb-2">
                        <CardTitle className="text-xs flex items-center gap-1.5 text-muted">
                          <MessageSquare className="w-3.5 h-3.5" />Stage 3 — HITL Response Draft
                          <Badge variant="amber" size="sm">human review</Badge>
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="text-xs text-muted mb-1">Queue: <span className="font-mono text-foreground">{s3.hitl_queue ?? '—'}</span></div>
                        <pre className="text-xs text-muted whitespace-pre-wrap bg-surface/40 rounded border border-surface-border p-2 max-h-40 overflow-y-auto">{s3.response_draft}</pre>
                      </CardContent>
                    </Card>
                  )}
                </div>
              )
            })}
          </div>

          <div className="flex justify-end">
            <Button variant="ghost" size="sm" onClick={() => setResult(null)}>
              <RefreshCw className="w-3.5 h-3.5 mr-1" />Reset
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

function ShadowPolicyPanel({ canPublish }: { canPublish: boolean }) {
  const [shadowVersion, setShadowVersion] = useState('')
  const [showDisableConfirm, setShowDisableConfirm] = useState(false)

  const { data: stats, refetch } = useQuery({
    queryKey: ['shadow', 'stats'],
    queryFn: () => shadowApi.getStats().then((r) => r.data),
    refetchInterval: 15_000,
    retry: false,
  })

  const enableMut = useMutation({
    mutationFn: (v: string) => shadowApi.enable({ shadow_version: v }),
    onSuccess: () => { toast.success('Shadow policy enabled'); void refetch() },
    onError: () => toast.error('Failed to enable shadow'),
  })

  const disableMut = useMutation({
    mutationFn: () => shadowApi.disable(),
    onSuccess: () => { toast.success('Shadow policy disabled'); setShowDisableConfirm(false); void refetch() },
    onError: () => toast.error('Failed to disable shadow'),
  })

  const isActive = stats?.is_active ?? false

  return (
    <div className="space-y-4">
      {/* Status Hero */}
      <Card className={cn('border-2', isActive ? 'border-amber-700/50 bg-amber-900/10' : 'border-surface-border')}>
        <CardContent className="py-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <Ghost className="w-5 h-5 text-amber-400" />
                <span className="font-semibold text-foreground">Shadow Policy</span>
                <Badge variant={isActive ? 'amber' : 'gray'}>{isActive ? 'Active' : 'Inactive'}</Badge>
              </div>
              {isActive && stats && (
                <div className="flex gap-6 mt-2 text-sm">
                  <div>
                    <span className="text-muted">Shadow: </span>
                    {stats.shadow_version && <VersionBadge version={stats.shadow_version} isShadow />}
                  </div>
                  <div>
                    <span className="text-muted">vs Active: </span>
                    {stats.active_version && <VersionBadge version={stats.active_version} isActive />}
                  </div>
                </div>
              )}
            </div>
            {canPublish && isActive && (
              <Button variant="danger" size="sm" onClick={() => setShowDisableConfirm(true)} loading={disableMut.isPending}>
                Disable Shadow
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Stats */}
      {isActive && stats && (
        <div className="grid grid-cols-3 gap-4">
          {[
            { label: 'Tickets Evaluated', value: stats.total_evaluated.toLocaleString() },
            { label: 'Decisions Changed', value: stats.decisions_changed.toLocaleString(), highlight: stats.decisions_changed > 0 },
            { label: 'Change Rate', value: `${(stats.change_rate * 100).toFixed(1)}%`, highlight: stats.change_rate > 0.05 },
          ].map((s) => (
            <Card key={s.label}>
              <CardContent className="py-3 text-center">
                <p className="text-xs text-subtle">{s.label}</p>
                <p className={cn('text-2xl font-bold mt-1', s.highlight ? 'text-amber-300' : 'text-foreground')}>{s.value}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Enable Form */}
      {!isActive && canPublish && (
        <Card>
          <CardHeader><CardTitle>Enable Shadow Policy</CardTitle></CardHeader>
          <CardContent>
            <div className="flex gap-3">
              <Input placeholder="Shadow version label" value={shadowVersion} onChange={(e) => setShadowVersion(e.target.value)} />
              <Button onClick={() => shadowVersion && enableMut.mutate(shadowVersion)} loading={enableMut.isPending} disabled={!shadowVersion}>
                <Ghost className="w-4 h-4" />Enable
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {!canPublish && (
        <Card>
          <CardContent>
            <p className="text-sm text-muted">Publisher role required to enable/disable shadow policy.</p>
          </CardContent>
        </Card>
      )}

      <ConfirmDialog
        open={showDisableConfirm}
        onClose={() => setShowDisableConfirm(false)}
        onConfirm={() => disableMut.mutate()}
        title="Disable Shadow Policy?"
        description="This will stop shadow evaluation. The active policy will continue serving all requests."
        confirmLabel="Disable"
        loading={disableMut.isPending}
      />
    </div>
  )
}
