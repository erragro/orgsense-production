// src/pages/tickets/TicketDetailPage.tsx
// PipelineStepper renders before the accordion sections:
//   CheckCircle (done) | Loader2 animate-spin (active) | XCircle (failed) | number (pending)
// API: ticketsApi.getDetail → TicketDetail  (ticket.types.ts)

import { useState } from 'react'
import { useParams,Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card,CardContent,CardHeader,CardTitle } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { StatusPill } from '@/components/common/StatusPill'
import { JsonViewer } from '@/components/common/JsonViewer'
import { CopyButton } from '@/components/common/CopyButton'
import { Skeleton } from '@/components/ui/Skeleton'
import { ticketsApi } from '@/api/governance/tickets.api'
import { formatDate } from '@/lib/dates'
import { formatCurrency,formatDuration,formatPercent } from '@/lib/utils'
import { cn } from '@/lib/cn'
import {
ChevronDown,ChevronRight,ArrowLeft,
CheckCircle,Loader2,XCircle,
} from 'lucide-react'
import type { TicketProcessingState } from '@/types/ticket.types'

// ─── Stage definitions (matches pipeline: Classification→Evaluation→Validation→Dispatch) ──
const PIPELINE_STAGES = [
  { num: 0, name: 'Classification', completedAtKey: 'stage_0_completed_at' },
  { num: 1, name: 'Evaluation',     completedAtKey: 'stage_1_completed_at' },
  { num: 2, name: 'Validation',     completedAtKey: 'stage_2_completed_at' },
  { num: 3, name: 'Dispatch',       completedAtKey: 'stage_3_completed_at' },
] as const

// ─── Pipeline stepper ─────────────────────────────────────────────────────────
function PipelineStepper({ ps, isComplete, isFailed }: {
  ps: TicketProcessingState
  isComplete: boolean
  isFailed: boolean
}) {
  return (
    <Card>
      <CardContent className="py-4">
        <div className="flex items-start">
          {PIPELINE_STAGES.map((stage, idx) => {
            const status      = (ps[`stage_${stage.num}_status` as keyof typeof ps] as string) ?? 'pending'
            const isDone      = status === 'completed'
            const isFail      = status === 'failed'
            const isActive    = ps.current_stage === stage.num && !isDone && !isFail && !isComplete && !isFailed
            const completedAt = ps[stage.completedAtKey as keyof typeof ps] as string | null

            return (
              <div key={stage.num} className="flex items-center flex-1 min-w-0">
                <div className="flex flex-col items-center gap-1.5 flex-1 min-w-0">
                  {/* Circle icon */}
                  <div className={cn(
                    'w-9 h-9 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-all duration-300',
                    isDone   && 'bg-green-500/15 border-green-500  text-green-400',
                    isFail   && 'bg-red-500/15   border-red-500    text-red-400',
                    isActive && 'bg-brand-500/15 border-brand-500  text-brand-400',
                    !isDone && !isFail && !isActive && 'bg-surface border-surface-border text-subtle',
                  )}>
                    {isDone   && <CheckCircle className="w-4 h-4" />}
                    {isFail   && <XCircle     className="w-4 h-4" />}
                    {isActive && <Loader2     className="w-4 h-4 animate-spin" />}
                    {!isDone && !isFail && !isActive && <span className="text-xs font-bold">{stage.num}</span>}
                  </div>
                  {/* Stage label */}
                  <div className="text-center px-1 w-full">
                    <p className={cn(
                      'text-xs font-semibold truncate',
                      isDone   ? 'text-green-300' :
                      isFail   ? 'text-red-300'   :
                      isActive ? 'text-brand-300' : 'text-subtle',
                    )}>{stage.name}</p>
                    <p className={cn('text-xs truncate mt-0.5', isActive ? 'text-brand-400' : 'text-subtle')}>
                      {isDone && completedAt ? formatDate(completedAt)
                        : isDone   ? 'Done'
                        : isFail   ? 'Failed'
                        : isActive ? 'Processing…'
                        : 'Pending'}
                    </p>
                  </div>
                </div>
                {/* Connector */}
                {idx < PIPELINE_STAGES.length - 1 && (
                  <div className={cn(
                    'h-0.5 w-4 flex-shrink-0 mx-1 transition-colors duration-300',
                    isDone ? 'bg-green-500' : isActive ? 'bg-brand-500/40' : 'bg-surface-border',
                  )} />
                )}
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}

export default function TicketDetailPage() {
  const { ticketId } = useParams<{ ticketId: string }>()
  const id = Number(ticketId)

  const { data: ticket, isLoading } = useQuery({
    queryKey: ['tickets', 'detail', id],
    queryFn: () => ticketsApi.getDetail(id).then((r) => r.data),
    enabled: !isNaN(id),
    refetchInterval: (query) => {
      const data = query.state.data
      if (!data) return false
      if (data.pipeline_stage === 'COMPLETED' || data.pipeline_stage === 'FAILED') return false
      return 2000
    },
  })

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-12" />
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
      </div>
    )
  }

  if (!ticket) {
    return (
      <div className="text-center py-16">
        <p className="text-muted">Ticket not found or endpoint not available.</p>
        <Link to="/tickets" className="text-brand-400 text-sm mt-2 inline-block">← Back to Tickets</Link>
      </div>
    )
  }

  const ps      = ticket.processing_state
  const l1      = ticket.llm_output_1
  const l2      = ticket.llm_output_2
  const l3      = ticket.llm_output_3
  const metrics = ticket.execution_metrics

  const isComplete  = ticket.pipeline_stage === 'COMPLETED'
  const isFailed    = ticket.pipeline_stage === 'FAILED'

  return (
    <div>
      <div className="mb-4">
        <Link to="/tickets" className="flex items-center gap-1 text-sm text-muted hover:text-foreground">
          <ArrowLeft className="w-3.5 h-3.5" />Back to Tickets
        </Link>
      </div>

      <PageHeader
        title={`Ticket #${ticket.ticket_id}`}
        subtitle={ticket.subject ?? 'No subject'}
        actions={
          <div className="flex items-center gap-2">
            {ticket.module && <Badge variant="blue">{ticket.module}</Badge>}
            <StatusPill status={ticket.pipeline_stage} />
          </div>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Main: Pipeline Accordion */}
        <div className="lg:col-span-2 space-y-3">

          {/* ── Pipeline stepper — primary progress indicator ── */}
          {ps && <PipelineStepper ps={ps} isComplete={isComplete} isFailed={isFailed} />}

          {/* Ingest Data */}
          <AccordionSection title="Ingest Data" defaultOpen>
            <div className="grid grid-cols-2 gap-3 text-xs mb-3">
              <div><span className="text-subtle">Email</span><p className="text-foreground">{ticket.cx_email ?? '—'}</p></div>
              <div><span className="text-subtle">Source</span><p className="text-foreground">{ticket.source}</p></div>
              <div><span className="text-subtle">Language</span><p className="text-foreground">{ticket.detected_language ?? '—'}</p></div>
              <div><span className="text-subtle">Created</span><p className="text-foreground">{formatDate(ticket.created_at)}</p></div>
            </div>
            {ticket.description && (
              <div className="bg-surface rounded-md p-3 text-sm text-foreground whitespace-pre-wrap">
                {ticket.description}
              </div>
            )}
          </AccordionSection>

          {/* Stage 0 */}
          {l1 && (
            <AccordionSection title="Stage 0 · Classification">
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div><span className="text-subtle">Issue L1</span><p className="text-foreground font-medium">{l1.issue_type_l1 ?? '—'}</p></div>
                <div><span className="text-subtle">Issue L2</span><p className="text-foreground font-medium">{l1.issue_type_l2 ?? '—'}</p></div>
                <div><span className="text-subtle">Confidence</span><p className="text-green-300 font-mono">{l1.confidence_entailment ? formatPercent(l1.confidence_entailment) : '—'}</p></div>
                <div><span className="text-subtle">Vector Match L1</span><p className="text-foreground">{l1.vector_top_match_l1 ?? '—'}</p></div>
                <div><span className="text-subtle">DB Match</span><p>{l1.db_issue_match ? <Badge variant="green">Yes</Badge> : <Badge variant="gray">No</Badge>}</p></div>
                <div><span className="text-subtle">Image Required</span><p>{l1.image_required ? <Badge variant="amber">Yes</Badge> : <Badge variant="gray">No</Badge>}</p></div>
              </div>
              {l1.reasoning && <p className="text-xs text-muted mt-3 italic bg-surface rounded p-2">{l1.reasoning}</p>}
            </AccordionSection>
          )}

          {/* Stage 1 */}
          {l2 && (
            <AccordionSection title="Stage 1 · Evaluation">
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div><span className="text-subtle">Action Code</span><p className="text-brand-400 font-mono font-bold">{l2.action_code ?? '—'}</p></div>
                <div><span className="text-subtle">Gratification</span><p className="text-green-300 font-mono">{l2.capped_gratification ? formatCurrency(l2.capped_gratification) : '—'}</p></div>
                <div><span className="text-subtle">Fraud Segment</span><p>{l2.fraud_segment ? <Badge variant="amber">{l2.fraud_segment}</Badge> : '—'}</p></div>
                <div><span className="text-subtle">Value Segment</span><p className="text-foreground">{l2.value_segment ?? '—'}</p></div>
                <div><span className="text-subtle">Greedy</span><p><Badge variant={l2.greedy_classification === 'GREEDY' ? 'red' : 'gray'}>{l2.greedy_classification}</Badge></p></div>
                <div><span className="text-subtle">SLA Breach</span><p>{l2.sla_breach ? <Badge variant="red">Yes</Badge> : <Badge variant="gray">No</Badge>}</p></div>
                <div><span className="text-subtle">Standard Logic</span><p>{l2.standard_logic_passed ? <Badge variant="green">Passed</Badge> : <Badge variant="red">Failed</Badge>}</p></div>
                <div><span className="text-subtle">Confidence</span><p className="text-foreground font-mono">{l2.overall_confidence ? formatPercent(l2.overall_confidence) : '—'}</p></div>
              </div>
              {l2.decision_reasoning && (
                <p className="text-xs text-muted mt-3 italic bg-surface rounded p-2">{l2.decision_reasoning}</p>
              )}
            </AccordionSection>
          )}

          {/* Stage 2 */}
          {l3 && (
            <AccordionSection title="Stage 2 · Validation">
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div><span className="text-subtle">Final Action</span><p className="text-brand-400 font-mono font-bold">{l3.final_action_code ?? '—'}</p></div>
                <div><span className="text-subtle">Refund Amount</span><p className="text-green-300 font-mono">{l3.final_refund_amount ? formatCurrency(l3.final_refund_amount) : '—'}</p></div>
                <div><span className="text-subtle">Automation Path</span><p className="text-foreground">{l3.automation_pathway ?? '—'}</p></div>
                <div><span className="text-subtle">Validation Status</span><p>{l3.logic_validation_status ? <StatusPill status={l3.logic_validation_status.toLowerCase()} /> : '—'}</p></div>
                <div><span className="text-subtle">Discrepancy</span><p><Badge variant={l3.discrepancy_detected ? 'red' : 'green'}>{l3.discrepancy_detected ? `${l3.discrepancy_count} found` : 'None'}</Badge></p></div>
                <div><span className="text-subtle">Policy Version</span><p className="text-foreground font-mono text-xs">{l3.policy_version ?? '—'}</p></div>
              </div>
              {l3.detailed_reasoning && (
                <p className="text-xs text-muted mt-3 italic bg-surface rounded p-2">{l3.detailed_reasoning}</p>
              )}
              {!!l3.decision_trace && (
                <div className="mt-3">
                  <p className="text-xs text-subtle mb-1">Decision Trace</p>
                  <JsonViewer data={l3.decision_trace} />
                </div>
              )}
            </AccordionSection>
          )}

          {/* Canonical Payload */}
          {!!ticket.canonical_payload && (
            <AccordionSection title="Canonical Payload">
              <JsonViewer data={ticket.canonical_payload} />
            </AccordionSection>
          )}
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          {/* Processing State — stage statuses with completion timestamps */}
          {ps && (
            <Card>
              <CardHeader><CardTitle>Processing State</CardTitle></CardHeader>
              <CardContent className="space-y-3 text-xs">
                <div className="grid grid-cols-2 gap-y-2">
                  {([0, 1, 2, 3] as const).map((n) => {
                    const status      = ps[`stage_${n}_status` as keyof typeof ps] as string
                    const completedAt = ps[`stage_${n}_completed_at` as keyof typeof ps] as string | null
                    return (
                      <div key={n}>
                        <span className="text-subtle">Stage {n}</span>
                        <p><StatusPill status={status} /></p>
                        {completedAt && <p className="text-subtle mt-0.5">{formatDate(completedAt)}</p>}
                      </div>
                    )
                  })}
                </div>
                {ps.claimed_by    && <div><span className="text-subtle">Worker</span> <p className="font-mono text-foreground">{ps.claimed_by}</p></div>}
                {ps.retry_count > 0 && <div><span className="text-subtle">Retries</span><p className="text-amber-300">{ps.retry_count}</p></div>}
                {ps.error_message  && <div><span className="text-subtle">Error</span>  <p className="text-red-300 break-words">{ps.error_message}</p></div>}
              </CardContent>
            </Card>
          )}

          {/* Execution Metrics */}
          {metrics && (
            <Card>
              <CardHeader><CardTitle>Execution Metrics</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-xs">
                <div>
                  <span className="text-subtle">Execution ID</span>
                  <div className="flex items-center gap-1">
                    <span className="font-mono text-xs text-brand-400 break-all">{metrics.execution_id ?? '—'}</span>
                    {metrics.execution_id && <CopyButton text={metrics.execution_id} />}
                  </div>
                </div>
                <div><span className="text-subtle">Duration</span><p className="font-mono">{formatDuration(metrics.duration_ms)}</p></div>
                <div><span className="text-subtle">Total Tokens</span><p className="font-mono">{metrics.total_tokens?.toLocaleString() ?? '—'}</p></div>
                <div className="grid grid-cols-3 gap-1 pt-1">
                  {(['llm_1_tokens', 'llm_2_tokens', 'llm_3_tokens'] as const).map((k, i) => (
                    <div key={k} className="text-center bg-surface rounded p-1">
                      <p className="text-subtle">L{i + 1}</p>
                      <p className="font-mono">{metrics[k]?.toLocaleString() ?? '—'}</p>
                    </div>
                  ))}
                </div>
                <div><span className="text-subtle">Status</span><p>{metrics.overall_status ? <StatusPill status={metrics.overall_status.toLowerCase()} /> : '—'}</p></div>
              </CardContent>
            </Card>
          )}

          {/* Meta */}
          <Card>
            <CardHeader><CardTitle>Metadata</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-xs">
              <div><span className="text-subtle">Ticket ID</span><p className="font-mono">{ticket.ticket_id}</p></div>
              <div><span className="text-subtle">Group</span><p>{ticket.group_name ?? ticket.group_id}</p></div>
              <div><span className="text-subtle">Source</span><p>{ticket.source}</p></div>
              <div><span className="text-subtle">Created</span><p>{formatDate(ticket.created_at)}</p></div>
              <div><span className="text-subtle">Updated</span><p>{formatDate(ticket.updated_at)}</p></div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

function AccordionSection({ title, children, defaultOpen = false }: {
  title: string
  children: React.ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <Card>
      <button
        className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-foreground hover:text-foreground"
        onClick={() => setOpen(!open)}
      >
        {title}
        {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
      </button>
      {open && (
        <CardContent className="pt-0">
          {children}
        </CardContent>
      )}
    </Card>
  )
}
