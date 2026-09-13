import { readSSEData } from '@/lib/sse'
import { useState,useRef,useEffect,useCallback } from 'react'
import { useQuery,useMutation,useQueryClient } from '@tanstack/react-query'
import {
ShieldCheck,Plus,Trash2,ChevronDown,ChevronUp,
Loader2,AlertTriangle,Search,BookOpen,CheckCircle2,
XCircle,AlertCircle,FileSearch,Play,RotateCcw,
ChevronRight,Cpu,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { useAuthStore } from '@/stores/auth.store'
import { hasPermission } from '@/lib/access'
import { qaApi } from '@/api/governance/qa.api'
import { getAccessToken } from '@/api/interceptors'
import { toast } from '@/stores/toast.store'
import { Spinner } from '@/components/ui/Spinner'
import { SixSigmaFlagsPanel } from './components/SixSigmaFlagsPanel'
import { MLHealthPanel } from './components/MLHealthPanel'
import type {
QASession,QATicketResult,
QAParameterResult,
MLCheckResult,
PythonCheckResult,
PythonSummary,
KBEvidence,
QASummary,
QASSEEvent,
TicketSearchParams
} from '@/types/qa.types'

const GOVERNANCE_URL = import.meta.env.VITE_GOVERNANCE_API_URL ?? (import.meta.env.PROD ? '/api/governance' : 'http://localhost:8001')

// ─── Grade helpers ────────────────────────────────────────────────────────────

function gradeColor(grade: string | null | undefined) {
  if (!grade) return 'text-muted'
  if (grade === 'A+' || grade === 'A') return 'text-emerald-400'
  if (grade === 'B+' || grade === 'B') return 'text-brand-400'
  if (grade === 'C') return 'text-amber-400'
  return 'text-red-400'
}

function scoreBg(score: number) {
  if (score >= 0.80) return 'bg-emerald-500'
  if (score >= 0.60) return 'bg-amber-500'
  return 'bg-red-500'
}

function scoreTextColor(score: number) {
  if (score >= 0.80) return 'text-emerald-400'
  if (score >= 0.60) return 'text-amber-400'
  return 'text-red-400'
}

function passLabel(pass: boolean, score: number) {
  if (pass) return { label: 'Pass', cls: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' }
  if (score >= 0.60) return { label: 'Warn', cls: 'bg-amber-500/15 text-amber-400 border-amber-500/30' }
  return { label: 'Fail', cls: 'bg-red-500/15 text-red-400 border-red-500/30' }
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' })
}

function formatPct(score: number | null | undefined) {
  if (score == null) return '—'
  return `${Math.round(score * 100)}%`
}

// ─── Category colour for Python checks ───────────────────────────────────────

const CATEGORY_STYLES: Record<string, string> = {
  Accuracy: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  Financial: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  Compliance: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
  Operational: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30',
  Quality: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  Risk: 'bg-red-500/15 text-red-400 border-red-500/30',
  Cost: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
}

// ─── Score Ring (SVG) ────────────────────────────────────────────────────────

function ScoreRing({
  score,
  grade,
  size = 'md',
  label,
}: {
  score: number
  grade: string
  size?: 'sm' | 'md' | 'lg'
  label?: string
}) {
  const dim = size === 'lg' ? 96 : size === 'sm' ? 56 : 76
  const r = size === 'lg' ? 38 : size === 'sm' ? 22 : 30
  const sw = size === 'lg' ? 8 : size === 'sm' ? 5 : 6
  const circ = 2 * Math.PI * r
  const fill = circ * (1 - score)
  const color = score >= 0.80 ? '#10b981' : score >= 0.60 ? '#f59e0b' : '#ef4444'
  const textSz = size === 'lg' ? 'text-xl' : size === 'sm' ? 'text-xs' : 'text-sm'
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative flex items-center justify-center" style={{ width: dim, height: dim }}>
        <svg
          className="absolute inset-0 w-full h-full -rotate-90"
          viewBox={`0 0 ${dim} ${dim}`}
        >
          <circle
            cx={dim / 2} cy={dim / 2} r={r}
            fill="none" stroke="currentColor" strokeWidth={sw}
            className="text-surface-border"
          />
          <circle
            cx={dim / 2} cy={dim / 2} r={r}
            fill="none" strokeWidth={sw}
            stroke={color}
            strokeDasharray={circ}
            strokeDashoffset={fill}
            strokeLinecap="round"
            style={{ transition: 'stroke-dashoffset 0.8s ease' }}
          />
        </svg>
        <div className="flex flex-col items-center z-10">
          <span className={cn('font-bold leading-none', textSz)} style={{ color }}>{grade}</span>
          <span className="text-[10px] text-muted mt-0.5">{formatPct(score)}</span>
        </div>
      </div>
      {label && <span className="text-[10px] text-muted text-center leading-tight">{label}</span>}
    </div>
  )
}

// ─── Python Check Card ────────────────────────────────────────────────────────

function PythonCheckCard({ check }: { check: PythonCheckResult }) {
  const [open, setOpen] = useState(false)
  const badge = passLabel(check.pass, check.score)
  const catStyle = CATEGORY_STYLES[check.category] ?? 'bg-surface-border text-muted border-surface-border'
  return (
    <div className="rounded-lg border border-surface-border bg-surface overflow-hidden">
      <button
        className="w-full flex items-start gap-2.5 p-2.5 text-left hover:bg-surface/70 transition-colors"
        onClick={() => setOpen(v => !v)}
      >
        {/* Mini score bar */}
        <div className="flex flex-col items-center gap-0.5 shrink-0 pt-0.5">
          <span className={cn('text-[11px] font-bold tabular-nums', scoreTextColor(check.score))}>
            {formatPct(check.score)}
          </span>
          <div className="w-1 h-8 rounded-full bg-surface-border overflow-hidden">
            <div
              className={cn('w-full rounded-full transition-all duration-700', scoreBg(check.score))}
              style={{ height: `${check.score * 100}%` }}
            />
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs font-medium text-foreground truncate">{check.name}</span>
            <div className="flex items-center gap-1 shrink-0">
              <span className={cn(
                'text-[9px] font-semibold px-1 py-0.5 rounded border',
                badge.cls
              )}>
                {badge.label}
              </span>
              {open
                ? <ChevronUp className="w-3 h-3 text-muted" />
                : <ChevronDown className="w-3 h-3 text-muted" />
              }
            </div>
          </div>
          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
            <span className={cn('text-[9px] font-medium px-1 py-0.5 rounded-sm border', catStyle)}>
              {check.category}
            </span>
            <span className="text-[9px] text-subtle bg-surface-border px-1 py-0.5 rounded-sm">
              {check.standard_ref}
            </span>
          </div>
          <p className="text-[10px] text-muted mt-1 line-clamp-2 leading-relaxed">{check.finding}</p>
        </div>
      </button>

      {open && (
        <div className="px-3 pb-2.5 pt-0 border-t border-surface-border bg-surface/20 space-y-1.5">
          <div>
            <span className="text-[9px] font-semibold text-muted uppercase tracking-wide">Finding</span>
            <p className="text-[10px] text-foreground mt-0.5 leading-relaxed">{check.finding}</p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <span className="text-[9px] font-semibold text-muted uppercase tracking-wide">Observed</span>
              <p className="text-[10px] text-foreground mt-0.5 font-mono">{check.value_observed}</p>
            </div>
            <div>
              <span className="text-[9px] font-semibold text-muted uppercase tracking-wide">Threshold</span>
              <p className="text-[10px] text-muted mt-0.5">{check.threshold}</p>
            </div>
          </div>
          <div className="text-[9px] text-subtle">Weight: {(check.weight * 100).toFixed(0)}%</div>
        </div>
      )}
    </div>
  )
}

// ─── Python Checks Section ────────────────────────────────────────────────────

function PythonChecksSection({
  checks,
  summary,
  streaming,
}: {
  checks: PythonCheckResult[]
  summary: PythonSummary | null
  streaming: boolean
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <Cpu className="w-4 h-4 text-cyan-400" />
        <span className="text-sm font-semibold text-foreground">Automated Python Checks</span>
        <span className="text-[10px] text-subtle bg-surface-border px-1.5 py-0.5 rounded-sm">
          Deterministic rule-based · No LLM
        </span>
        {summary && (
          <div className="ml-auto flex items-center gap-2">
            <span className={cn('text-sm font-bold', gradeColor(summary.python_grade))}>
              {summary.python_grade}
            </span>
            <span className="text-xs text-muted">{formatPct(summary.python_score)}</span>
            <div className="flex items-center gap-1 text-[10px] text-emerald-400">
              <CheckCircle2 className="w-3 h-3" />{summary.python_pass_count}
            </div>
            <div className="flex items-center gap-1 text-[10px] text-red-400">
              <XCircle className="w-3 h-3" />{summary.python_fail_count}
            </div>
          </div>
        )}
        {!summary && streaming && (
          <span className="text-[10px] text-muted ml-auto">
            ({checks.length}/12 — running…)
          </span>
        )}
        {!summary && !streaming && checks.length > 0 && (
          <span className="text-[10px] text-muted ml-auto">({checks.length}/12)</span>
        )}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
        {checks.map((c, i) => (
          <PythonCheckCard key={i} check={c} />
        ))}
        {/* Skeleton placeholders while streaming */}
        {streaming && Array.from({ length: 12 - checks.length }).map((_, i) => (
          <div key={`py-sk-${i}`} className="rounded-lg border border-surface-border bg-surface p-2.5 animate-pulse">
            <div className="h-2.5 w-32 bg-surface-border rounded mb-1.5" />
            <div className="h-2 w-24 bg-surface-border rounded mb-2" />
            <div className="h-2 w-full bg-surface-border rounded" />
          </div>
        ))}
      </div>
    </div>
  )
}


// ─── KB Evidence Panel ────────────────────────────────────────────────────────

function KBEvidencePanel({ evidence }: { evidence: KBEvidence }) {
  const [section, setSection] = useState<'rules' | 'issues' | 'actions'>('rules')

  return (
    <div className="flex flex-col h-full">
      {/* Tabs */}
      <div className="flex border-b border-surface-border shrink-0">
        {(['rules', 'issues', 'actions'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setSection(tab)}
            className={cn(
              'flex-1 py-2 text-xs font-medium capitalize transition-colors',
              section === tab
                ? 'text-brand-400 border-b-2 border-brand-400 -mb-px'
                : 'text-muted hover:text-foreground'
            )}
          >
            {tab} ({
              tab === 'rules' ? evidence.rules.length
                : tab === 'issues' ? evidence.issues.length
                  : evidence.actions.length
            })
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {section === 'rules' && (
          evidence.rules.length === 0
            ? <p className="text-xs text-muted text-center py-4">No rules retrieved</p>
            : evidence.rules.map((r, i) => (
              <div key={i} className="rounded border border-surface-border bg-surface/50 p-2 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] font-mono bg-brand-600/20 text-brand-400 px-1.5 py-0.5 rounded">
                    {r.rule_id}
                  </span>
                  <span className="text-[10px] text-muted">{r.module_name}</span>
                </div>
                <div className="text-xs text-foreground font-medium">{r.action_name}</div>
                <p className="text-[10px] text-muted leading-relaxed line-clamp-3">{r.semantic_text}</p>
              </div>
            ))
        )}
        {section === 'issues' && (
          evidence.issues.length === 0
            ? <p className="text-xs text-muted text-center py-4">No issue matches retrieved</p>
            : evidence.issues.map((iss, i) => (
              <div key={i} className="rounded border border-surface-border bg-surface/50 p-2 space-y-1">
                <div className="text-xs font-medium text-foreground">{iss.label}</div>
                <div className="text-[10px] text-muted">L{iss.level} · {iss.issue_code}</div>
                <p className="text-[10px] text-muted line-clamp-2">{iss.description}</p>
              </div>
            ))
        )}
        {section === 'actions' && (
          evidence.actions.length === 0
            ? <p className="text-xs text-muted text-center py-4">No action matches retrieved</p>
            : evidence.actions.map((act, i) => (
              <div key={i} className="rounded border border-surface-border bg-surface/50 p-2 space-y-1">
                <div className="text-xs font-medium text-foreground">{act.action_name}</div>
                <div className="flex gap-1.5 flex-wrap">
                  {act.requires_refund && (
                    <span className="text-[10px] bg-amber-500/15 text-amber-400 px-1.5 py-0.5 rounded">Refund</span>
                  )}
                  {act.requires_escalation && (
                    <span className="text-[10px] bg-red-500/15 text-red-400 px-1.5 py-0.5 rounded">Escalation</span>
                  )}
                  {act.automation_eligible && (
                    <span className="text-[10px] bg-emerald-500/15 text-emerald-400 px-1.5 py-0.5 rounded">Auto</span>
                  )}
                </div>
                <p className="text-[10px] text-muted line-clamp-2">{act.action_description}</p>
              </div>
            ))
        )}
      </div>
    </div>
  )
}

// ─── Ticket List Panel ────────────────────────────────────────────────────────

function TicketListPanel({ onAudit }: { onAudit: (t: QATicketResult) => void }) {
  const [filter, setFilter] = useState('')

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['qa-ticket-list'],
    queryFn: () => qaApi.searchTickets({ limit: 30 } as TicketSearchParams).then(r => r.data),
    staleTime: 60_000,
  })

  const tickets = (data ?? []).filter(t =>
    !filter ||
    String(t.ticket_id).includes(filter) ||
    t.subject.toLowerCase().includes(filter.toLowerCase())
  )

  return (
    <div className="space-y-3">
      {/* Filter bar */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted pointer-events-none" />
          <input
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="Filter by ID or subject…"
            className="w-full pl-8 pr-3 py-1.5 rounded-md border border-surface-border bg-surface text-sm text-foreground placeholder:text-subtle focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="p-1.5 rounded-md border border-surface-border text-muted hover:text-foreground hover:bg-surface-border transition-colors disabled:opacity-50"
          title="Refresh"
        >
          <RotateCcw className={cn('w-3.5 h-3.5', isFetching && 'animate-spin')} />
        </button>
      </div>

      {/* Loading skeletons */}
      {isLoading && (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map(i => (
            <div key={i} className="h-14 rounded-lg bg-surface-border/40 animate-pulse" />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!isLoading && tickets.length === 0 && (
        <p className="text-xs text-muted text-center py-6">
          {filter ? 'No tickets match your filter.' : 'No completed tickets found.'}
        </p>
      )}

      {/* Ticket rows */}
      {!isLoading && tickets.length > 0 && (
        <div className="space-y-1.5 max-h-[420px] overflow-y-auto pr-0.5">
          {tickets.map(t => (
            <div
              key={t.ticket_id}
              className="flex items-center gap-3 rounded-lg border border-surface-border bg-surface px-3 py-2.5 hover:border-brand-500/40 hover:bg-surface-card transition-all group"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-mono font-bold text-brand-400">#{t.ticket_id}</span>
                  {t.module && (
                    <span className="text-[10px] bg-surface-border text-muted px-1.5 py-0.5 rounded">
                      {t.module}
                    </span>
                  )}
                  {t.issue_type_l1 && (
                    <span className="text-[10px] text-muted">
                      {t.issue_type_l1}{t.issue_type_l2 ? ` › ${t.issue_type_l2}` : ''}
                    </span>
                  )}
                  {t.overall_confidence != null && (
                    <span className="text-[10px] text-emerald-400 ml-auto shrink-0">
                      {(t.overall_confidence * 100).toFixed(0)}% conf
                    </span>
                  )}
                </div>
                <p className="text-xs text-foreground mt-0.5 truncate">{t.subject}</p>
                <p className="text-[10px] text-muted mt-0.5">{formatDate(t.processing_completed_at)}</p>
              </div>
              <button
                onClick={() => onAudit(t)}
                className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-brand-600 hover:bg-brand-500 text-white text-xs font-semibold transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
              >
                <Play className="w-3 h-3" /> Audit
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Live evaluation state ────────────────────────────────────────────────────

interface LiveEval {
  status: string
  pythonChecks: PythonCheckResult[]
  pythonSummary: PythonSummary | null
  mlChecks: MLCheckResult[]
  parameters: QAParameterResult[]
  summary: QASummary | null
  kbEvidence: KBEvidence | null
  evaluationId: number | null
  error: string | null
  streaming: boolean
  done: boolean
}

const emptyLiveEval = (): LiveEval => ({
  status: '',
  pythonChecks: [],
  pythonSummary: null,
  mlChecks: [],
  parameters: [],
  summary: null,
  kbEvidence: null,
  evaluationId: null,
  error: null,
  streaming: false,
  done: false,
})

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function QAAgentPage() {
  const { user } = useAuthStore()
  const canAdmin = hasPermission(user, 'policy', 'admin') || !!user?.is_super_admin
  const qc = useQueryClient()
  const abortRef = useRef<AbortController | null>(null)

  const [activeSession, setActiveSession] = useState<QASession | null>(null)
  const [activeEvalId, setActiveEvalId] = useState<number | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editLabel, setEditLabel] = useState('')
  const [, setSelectedTicket] = useState<QATicketResult | null>(null)
  const [live, setLive] = useState<LiveEval>(emptyLiveEval())
  const [kbPanelOpen, setKbPanelOpen] = useState(true)
  const resultsEndRef = useRef<HTMLDivElement>(null)

  // ── Sessions ────────────────────────────────────────────────────────────
  const { data: sessions = [], isLoading: sessionsLoading } = useQuery({
    queryKey: ['qa-sessions'],
    queryFn: () => qaApi.getSessions().then(r => r.data),
  })

  useEffect(() => {
    if (sessions.length > 0 && !activeSession) {
      setActiveSession(sessions[0])
    }
  }, [sessions, activeSession])

  const createSession = useMutation({
    mutationFn: () => qaApi.createSession('New QA Session').then(r => r.data),
    onSuccess: s => {
      qc.invalidateQueries({ queryKey: ['qa-sessions'] })
      setActiveSession(s)
      setActiveEvalId(null)
      setLive(emptyLiveEval())
      setSelectedTicket(null)
    },
  })

  const renameSession = useMutation({
    mutationFn: ({ id, label }: { id: number; label: string }) =>
      qaApi.renameSession(id, label).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['qa-sessions'] })
      setEditingId(null)
    },
  })

  const deleteSession = useMutation({
    mutationFn: (id: number) => qaApi.deleteSession(id),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['qa-sessions'] })
      if (activeSession?.id === id) {
        setActiveSession(null)
        setActiveEvalId(null)
        setLive(emptyLiveEval())
      }
      toast.success('Session deleted')
    },
  })

  // ── Evaluations in session ───────────────────────────────────────────────
  const { data: sessionEvals = [] } = useQuery({
    queryKey: ['qa-evaluations', activeSession?.id],
    queryFn: () => qaApi.getSessionEvaluations(activeSession!.id).then(r => r.data),
    enabled: !!activeSession,
  })

  // ── Load persisted evaluation ────────────────────────────────────────────
  const { data: loadedEval, isLoading: evalLoading } = useQuery({
    queryKey: ['qa-evaluation-detail', activeEvalId],
    queryFn: () => qaApi.getEvaluation(activeEvalId!).then(r => r.data),
    enabled: !!activeEvalId && !live.streaming,
  })

  // Sync loaded eval into live state
  useEffect(() => {
    if (!loadedEval || live.streaming) return
    const allFindings = (loadedEval.findings as (QAParameterResult | MLCheckResult)[]) ?? []
    // Split persisted findings into LLM parameters vs ML checks (by source field)
    const findings = allFindings.filter(f => !('source' in f) || (f as MLCheckResult).source !== 'ml') as QAParameterResult[]
    const mlChecks = allFindings.filter(f => ('source' in f) && (f as MLCheckResult).source === 'ml') as MLCheckResult[]
    setLive({
      status: '',
      pythonChecks: (loadedEval.python_findings as PythonCheckResult[]) ?? [],
      pythonSummary: loadedEval.python_qa_score != null ? {
        python_score: loadedEval.python_qa_score,
        python_grade: '',
        python_pass_count: ((loadedEval.python_findings as PythonCheckResult[]) ?? []).filter(c => c.pass).length,
        python_fail_count: ((loadedEval.python_findings as PythonCheckResult[]) ?? []).filter(c => !c.pass).length,
      } : null,
      mlChecks,
      parameters: findings,
      summary: loadedEval.overall_score != null ? {
        overall_score: loadedEval.overall_score,
        grade: loadedEval.grade ?? '—',
        pass_count: findings.filter(p => p.pass).length,
        warn_count: 0,
        fail_count: findings.filter(p => !p.pass).length,
        audit_narrative: '',
      } : null,
      kbEvidence: loadedEval.kb_evidence ?? null,
      evaluationId: loadedEval.id,
      error: null,
      streaming: false,
      done: true,
    })
  }, [loadedEval, live.streaming])

  // ── Scroll to bottom when params appear ─────────────────────────────────
  useEffect(() => {
    if (live.parameters.length > 0) {
      resultsEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }
  }, [live.parameters.length])

  // ── SSE Evaluate ────────────────────────────────────────────────────────
  const runEvaluation = useCallback(async (ticket: QATicketResult) => {
    if (!activeSession) return

    setSelectedTicket(ticket)
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl

    setActiveEvalId(null)
    setLive({ ...emptyLiveEval(), streaming: true })

    const token = getAccessToken()
    const res = await fetch(`${GOVERNANCE_URL}/qa-agent/evaluate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        session_id: activeSession.id,
        ticket_id: ticket.ticket_id,
      }),
      signal: ctrl.signal,
    }).catch(() => null)

    if (!res?.ok) {
      setLive(prev => ({
        ...prev,
        streaming: false,
        error: 'Failed to start QA evaluation. Check your connection.',
      }))
      return
    }

    let completed = false
    const processData = (data: string) => {
      try {
        const evt = JSON.parse(data) as QASSEEvent
        if (evt.type === 'done' || evt.type === 'error') completed = true
        setLive(prev => {
          switch (evt.type) {
            case 'status':
              return { ...prev, status: evt.text ?? '' }
            case 'kb_evidence':
              return {
                ...prev,
                kbEvidence: {
                  rules: evt.rules ?? [],
                  issues: evt.issues ?? [],
                  actions: evt.actions ?? [],
                },
              }
            case 'python_check':
              return {
                ...prev,
                pythonChecks: [...prev.pythonChecks, {
                  name: evt.name!,
                  category: evt.category as PythonCheckResult['category'],
                  standard_ref: evt.standard_ref ?? '',
                  score: evt.score!,
                  weight: evt.weight!,
                  pass: evt.pass!,
                  value_observed: evt.value_observed ?? '',
                  threshold: evt.threshold ?? '',
                  finding: evt.finding!,
                  method: 'python_deterministic',
                }],
              }
            case 'python_summary':
              return {
                ...prev,
                pythonSummary: {
                  python_score: evt.python_score!,
                  python_grade: evt.python_grade!,
                  python_pass_count: evt.python_pass_count!,
                  python_fail_count: evt.python_fail_count!,
                },
              }
            case 'ml_check':
              return {
                ...prev,
                mlChecks: [...prev.mlChecks, {
                  name: evt.name!,
                  score: evt.score!,
                  weight: evt.weight!,
                  pass: evt.pass!,
                  finding: evt.finding!,
                  source: 'ml' as const,
                }],
              }
            case 'parameter':
              return {
                ...prev,
                parameters: [...prev.parameters, {
                  name: evt.name!,
                  score: evt.score!,
                  weight: evt.weight!,
                  finding: evt.finding!,
                  recommendation: evt.recommendation!,
                  pass: evt.pass!,
                }],
              }
            case 'summary':
              return {
                ...prev,
                summary: {
                  overall_score: evt.overall_score!,
                  grade: evt.grade!,
                  pass_count: evt.pass_count!,
                  warn_count: evt.warn_count ?? 0,
                  fail_count: evt.fail_count!,
                  audit_narrative: evt.audit_narrative ?? '',
                },
              }
            case 'done':
              return {
                ...prev,
                streaming: false,
                done: true,
                status: '',
                evaluationId: evt.evaluation_id ?? null,
              }
            case 'error':
              return {
                ...prev,
                streaming: false,
                error: evt.text ?? 'Unknown error',
              }
            default:
              return prev
          }
        })

        if (evt.type === 'done') {
          qc.invalidateQueries({ queryKey: ['qa-evaluations', activeSession.id] })
          qc.invalidateQueries({ queryKey: ['qa-sessions'] })
        }
      } catch {
        // ignore parse errors
      }
    }

    try {
      if (!res.body) throw new Error('Missing stream body')
      for await (const data of readSSEData(res.body)) processData(data)
      if (!completed) throw new Error('Stream ended before completion')
      setLive(prev => ({ ...prev, streaming: false }))
    } catch (e: unknown) {
      if ((e as Error).name !== 'AbortError') {
        setLive(prev => ({ ...prev, streaming: false, error: 'Stream disconnected.' }))
      }
    }
  }, [activeSession, qc])

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full overflow-hidden">

      {/* ── Left: Sessions sidebar ──────────────────────────────────────────── */}
      <aside className="w-56 shrink-0 flex flex-col border-r border-surface-border bg-surface overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-3 border-b border-surface-border shrink-0">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-brand-400" />
            <span className="text-xs font-semibold text-foreground">QA Sessions</span>
          </div>
          <button
            onClick={() => createSession.mutate()}
            disabled={createSession.isPending}
            className="w-6 h-6 rounded flex items-center justify-center text-muted hover:text-foreground hover:bg-surface-border transition-colors"
            title="New session"
          >
            {createSession.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
          </button>
        </div>

        {/* Sessions list */}
        <div className="flex-1 overflow-y-auto">
          {sessionsLoading ? (
            <div className="flex justify-center pt-6"><Spinner size="sm" /></div>
          ) : sessions.length === 0 ? (
            <p className="text-xs text-muted text-center px-3 pt-6">No sessions yet</p>
          ) : (
            sessions.map(s => (
              <div key={s.id} className="group">
                {editingId === s.id ? (
                  <div className="px-3 py-1.5">
                    <input
                      autoFocus
                      value={editLabel}
                      onChange={e => setEditLabel(e.target.value)}
                      onBlur={() => {
                        if (editLabel.trim()) renameSession.mutate({ id: s.id, label: editLabel.trim() })
                        else setEditingId(null)
                      }}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          renameSession.mutate({ id: s.id, label: editLabel.trim() })
                        }
                        if (e.key === 'Escape') setEditingId(null)
                      }}
                      className="w-full text-xs bg-surface-border rounded px-2 py-1 text-foreground outline-none"
                    />
                  </div>
                ) : (
                  <button
                    onClick={() => {
                      setActiveSession(s)
                      setActiveEvalId(null)
                      setLive(emptyLiveEval())
                      setSelectedTicket(null)
                    }}
                    onDoubleClick={() => { setEditingId(s.id); setEditLabel(s.label) }}
                    className={cn(
                      'w-full flex items-center gap-2 px-3 py-2 text-left transition-colors',
                      activeSession?.id === s.id
                        ? 'bg-brand-600/15 text-foreground'
                        : 'text-muted hover:bg-surface-border/50 hover:text-foreground'
                    )}
                  >
                    <span className="flex-1 text-xs truncate">{s.label}</span>
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={e => { e.stopPropagation(); deleteSession.mutate(s.id) }}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); deleteSession.mutate(s.id) } }}
                      className="opacity-0 group-hover:opacity-100 w-5 h-5 flex items-center justify-center rounded hover:text-red-400 transition-all"
                    >
                      <Trash2 className="w-3 h-3" />
                    </div>
                  </button>
                )}

                {/* Evaluations under session */}
                {activeSession?.id === s.id && sessionEvals.length > 0 && (
                  <div className="ml-4 border-l border-surface-border pl-2 mb-1">
                    {sessionEvals.map(ev => (
                      <button
                        key={ev.id}
                        onClick={() => {
                          setActiveEvalId(ev.id)
                          setLive(emptyLiveEval())
                          setSelectedTicket(null)
                        }}
                        className={cn(
                          'w-full flex items-center gap-1.5 px-2 py-1.5 text-left rounded transition-colors',
                          activeEvalId === ev.id
                            ? 'bg-surface-border text-foreground'
                            : 'text-muted hover:bg-surface-border/40 hover:text-foreground'
                        )}
                      >
                        <ChevronRight className="w-3 h-3 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className={cn('text-[10px] font-bold', gradeColor(ev.grade))}>
                              {ev.grade ?? '…'}
                            </span>
                            <span className="text-[10px] text-muted font-mono">#{ev.ticket_id}</span>
                          </div>
                          <p className="text-[10px] text-muted truncate">{ev.ticket_subject ?? ''}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </aside>

      {/* ── Centre: Main area ───────────────────────────────────────────────── */}
      <main className="flex-1 flex flex-col overflow-hidden">

        {!activeSession ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center p-8">
            <ShieldCheck className="w-12 h-12 text-surface-border" />
            <div>
              <h2 className="text-foreground font-semibold">QA Agent</h2>
              <p className="text-sm text-muted mt-1">
                Create a session to start auditing processed tickets
              </p>
            </div>
            <button
              onClick={() => createSession.mutate()}
              className="flex items-center gap-2 px-4 py-2 rounded-md bg-brand-600 hover:bg-brand-500 text-white text-sm font-medium transition-colors"
            >
              <Plus className="w-4 h-4" /> New QA Session
            </button>
          </div>
        ) : (
          <div className="flex-1 flex flex-col overflow-hidden">

            {/* Session header */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-surface-border shrink-0">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-brand-400" />
                <span className="text-sm font-semibold text-foreground">{activeSession.label}</span>
              </div>
              {(live.streaming || live.done) && (
                <button
                  onClick={() => {
                    abortRef.current?.abort()
                    setLive(emptyLiveEval())
                    setActiveEvalId(null)
                    setSelectedTicket(null)
                  }}
                  className="flex items-center gap-1.5 text-xs text-muted hover:text-foreground transition-colors"
                >
                  <RotateCcw className="w-3.5 h-3.5" /> New Audit
                </button>
              )}
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">

              {/* ── Completed ticket list (shown when not streaming/done) ── */}
              {!live.streaming && !live.done && !activeEvalId && (
                <div className="rounded-xl border border-surface-border bg-surface-card p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <FileSearch className="w-4 h-4 text-brand-400" />
                    <span className="text-sm font-semibold text-foreground">Completed Tickets</span>
                  </div>
                  <TicketListPanel onAudit={ticket => { setActiveEvalId(null); runEvaluation(ticket) }} />
                </div>
              )}

              {/* ── Streaming status ── */}
              {live.streaming && (
                <div className="flex items-center gap-2 text-sm text-brand-400 py-1">
                  <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                  <span>{live.status || 'Initialising…'}</span>
                </div>
              )}
              {!live.streaming && live.status && live.done && (
                <div className="text-xs text-muted">{live.status}</div>
              )}

              {/* ── Error ── */}
              {live.error && (
                <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  {live.error}
                </div>
              )}

              {/* ── Loading persisted eval ── */}
              {evalLoading && activeEvalId && (
                <div className="flex justify-center py-10"><Spinner size="md" /></div>
              )}

              {/* ── 1. Python Checks section (appears first, instant) ── */}
              {(live.pythonChecks.length > 0 || (live.streaming && live.status.includes('Python'))) && (
                <div className="rounded-xl border border-surface-border bg-surface-card p-4">
                  <PythonChecksSection
                    checks={live.pythonChecks}
                    summary={live.pythonSummary}
                    streaming={live.streaming && live.pythonChecks.length < 12}
                  />
                </div>
              )}

              {/* ── 2. Summary card (blended score) ── */}
              {live.summary && (
                <div className="rounded-xl border border-surface-border bg-surface-card p-5">
                  <div className="flex items-start gap-5 flex-wrap">
                    {/* Main blended ring */}
                    <ScoreRing
                      score={live.summary.overall_score}
                      grade={live.summary.grade}
                      size="lg"
                      label="Blended Score"
                    />

                    {/* Sub-rings for Python and AI */}
                    <div className="flex gap-4 items-start">
                      {live.pythonSummary && (
                        <ScoreRing
                          score={live.pythonSummary.python_score}
                          grade={live.pythonSummary.python_grade}
                          size="sm"
                          label="Python Checks"
                        />
                      )}
                      <ScoreRing
                        score={live.summary.overall_score}
                        grade={live.summary.grade}
                        size="sm"
                        label="AI Evaluation"
                      />
                    </div>

                    <div className="flex-1 min-w-0">
                      <h3 className="text-base font-bold text-foreground">QA Audit Complete</h3>
                      {live.evaluationId && (
                        <p className="text-[10px] text-muted mt-0.5">Evaluation #{live.evaluationId}</p>
                      )}
                      {live.pythonSummary && (
                        <p className="text-[10px] text-subtle mt-1">
                          Blended: 35% Python checks + 65% AI evaluation
                        </p>
                      )}
                      <div className="flex items-center gap-3 mt-2 flex-wrap">
                        <div className="flex items-center gap-1 text-xs text-emerald-400">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          {live.summary.pass_count} Pass
                        </div>
                        {live.summary.warn_count > 0 && (
                          <div className="flex items-center gap-1 text-xs text-amber-400">
                            <AlertCircle className="w-3.5 h-3.5" />
                            {live.summary.warn_count} Warn
                          </div>
                        )}
                        <div className="flex items-center gap-1 text-xs text-red-400">
                          <XCircle className="w-3.5 h-3.5" />
                          {live.summary.fail_count} Fail
                        </div>
                      </div>
                      {live.summary.audit_narrative && (
                        <p className="text-xs text-muted mt-2 leading-relaxed max-w-xl">
                          {live.summary.audit_narrative}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* ── 3. Six Sigma + ML quality checks ── */}
              {(live.parameters.length > 0 || live.mlChecks.length > 0 ||
                (live.streaming && live.status.includes('Six Sigma'))) && (
                <div className="rounded-xl border border-surface-border bg-surface-card p-4">
                  <SixSigmaFlagsPanel
                    parameters={live.parameters}
                    mlChecks={live.mlChecks}
                    evaluationId={live.evaluationId}
                    canAdmin={canAdmin}
                    streaming={live.streaming && live.parameters.length < 6}
                  />
                </div>
              )}

              {canAdmin && (
                <MLHealthPanel canAdmin={canAdmin} />
              )}

              <div ref={resultsEndRef} />
            </div>
          </div>
        )}
      </main>

      {/* ── Right: KB Evidence panel ────────────────────────────────────────── */}
      {(live.kbEvidence || live.streaming) && (
        <aside
          className={cn(
            'shrink-0 flex flex-col border-l border-surface-border bg-surface transition-all duration-300',
            kbPanelOpen ? 'w-72' : 'w-9'
          )}
        >
          {/* Toggle header */}
          <button
            onClick={() => setKbPanelOpen(v => !v)}
            className="flex items-center gap-2 px-3 py-3 border-b border-surface-border hover:bg-surface-border/30 transition-colors shrink-0 w-full"
          >
            <BookOpen className="w-4 h-4 text-brand-400 shrink-0" />
            {kbPanelOpen && (
              <span className="flex-1 text-xs font-semibold text-foreground text-left">KB Evidence</span>
            )}
            {kbPanelOpen
              ? <ChevronRight className="w-3.5 h-3.5 text-muted shrink-0" />
              : <ChevronRight className="w-3.5 h-3.5 text-muted shrink-0 rotate-180" />
            }
          </button>

          {kbPanelOpen && (
            <div className="flex-1 overflow-hidden">
              {live.streaming && !live.kbEvidence ? (
                <div className="flex flex-col items-center justify-center h-32 gap-2">
                  <Loader2 className="w-4 h-4 animate-spin text-brand-400" />
                  <span className="text-xs text-muted">Retrieving KB…</span>
                </div>
              ) : live.kbEvidence ? (
                <KBEvidencePanel evidence={live.kbEvidence} />
              ) : null}
            </div>
          )}
        </aside>
      )}
    </div>
  )
}
