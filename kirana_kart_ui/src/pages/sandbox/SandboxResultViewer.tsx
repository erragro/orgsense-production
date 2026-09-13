// src/pages/sandbox/SandboxResultViewer.tsx
// Stage tracker uses Loader2 animate-spin (active) / CheckCircle (done) / XCircle (failed).
// Auto-polls every 2 s via ticketsApi.getDetail until COMPLETED or FAILED.
// API: ticketsApi.getDetail  (tickets.api.ts)  →  TicketDetail (ticket.types.ts)

import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { JsonViewer } from '@/components/common/JsonViewer'
import { CopyButton } from '@/components/common/CopyButton'
import { EmptyState } from '@/components/common/EmptyState'
import { StatusPill } from '@/components/common/StatusPill'
import { ticketsApi } from '@/api/governance/tickets.api'
import type { IngestResponse, TicketDetail } from '@/types/ticket.types'
import { formatCurrency, formatPercent } from '@/lib/utils'
import { formatDate } from '@/lib/dates'
import { cn } from '@/lib/cn'
import { FlaskConical, CheckCircle, Clock, ExternalLink, Loader2, XCircle } from 'lucide-react'

interface Props {
  result: IngestResponse | null
  loading: boolean
}

const STAGES = [
  { num: 0, name: 'Classification', desc: 'Issue type identification',       file: 'llm_output_1' },
  { num: 1, name: 'Evaluation',     desc: 'Policy check & action decision',  file: 'llm_output_2' },
  { num: 2, name: 'Validation',     desc: 'Logic cross-validation',          file: 'llm_output_3' },
  { num: 3, name: 'Dispatch',       desc: 'Response generation & sync',      file: 'processing_state' },
] as const

export function SandboxResultViewer({ result, loading }: Props) {
  const { data: ticketDetail, isFetching } = useQuery({
    queryKey: ['tickets', 'detail', result?.ticket_id],
    queryFn: () => ticketsApi.getDetail(result!.ticket_id!).then((r) => r.data),
    enabled: result?.ticket_id != null,
    refetchInterval: (query) => {
      const data = query.state.data as TicketDetail | undefined
      if (!data) return 2000
      const stage = data.processing_state?.current_stage ?? -1
      if (data.pipeline_stage === 'COMPLETED' || data.pipeline_stage === 'FAILED') {
        return false
      }
      if (stage >= 3) {
        return false
      }
      return 2000
    },
  })

  if (loading && !result) {
    return (
      <Card className="h-full">
        <CardContent className="flex flex-col items-center justify-center py-20 gap-4">
          <Spinner size="lg" />
          <p className="text-sm text-muted">Submitting to ingest pipeline…</p>
        </CardContent>
      </Card>
    )
  }

  if (!result) {
    return (
      <Card className="h-full">
        <CardContent>
          <EmptyState
            icon={<FlaskConical className="w-10 h-10 text-subtle" />}
            title="No result yet"
            description="Submit a ticket using the form on the left to see the pipeline results here."
          />
        </CardContent>
      </Card>
    )
  }

  const ps = ticketDetail?.processing_state
  const l1 = ticketDetail?.llm_output_1
  const l2 = ticketDetail?.llm_output_2
  const l3 = ticketDetail?.llm_output_3

  const currentStage = ps?.current_stage ?? -1
  const isComplete = ticketDetail?.pipeline_stage === 'COMPLETED'
  const isFailed = ticketDetail?.pipeline_stage === 'FAILED'

  return (
    <div className="space-y-4">
      {/* Ingest Response */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Ingest Response</CardTitle>
            <Badge variant={result.status === 'accepted' ? 'green' : result.status === 'duplicate' ? 'amber' : 'red'}>
              {result.status}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <span className="text-subtle">Execution ID</span>
              <div className="flex items-center gap-1 mt-0.5">
                <span className="font-mono text-brand-400">{result.execution_id}</span>
                <CopyButton text={result.execution_id} />
              </div>
            </div>
            {result.ticket_id != null && (
              <div>
                <span className="text-subtle">Ticket ID</span>
                <div className="flex items-center gap-1 mt-0.5">
                  <span className="font-mono text-foreground">#{result.ticket_id}</span>
                  <CopyButton text={String(result.ticket_id)} />
                </div>
              </div>
            )}
            <div>
              <span className="text-subtle">Sandbox</span>
              <div className="mt-0.5">
                <Badge variant={result.is_sandbox ? 'blue' : 'gray'}>
                  {result.is_sandbox ? 'Yes' : 'No'}
                </Badge>
              </div>
            </div>
            <div>
              <span className="text-subtle">Received At</span>
              <p className="text-foreground mt-0.5">{formatDate(result.received_at)}</p>
            </div>
          </div>
          <p className="text-xs text-subtle mt-3">{result.message}</p>
        </CardContent>
      </Card>

      {/* Pipeline Progress */}
      {result.ticket_id != null && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Pipeline Progress</CardTitle>
              {isFetching && <Spinner size="sm" />}
              {isComplete && <Badge variant="green"><CheckCircle className="w-3 h-3 mr-1" />Complete</Badge>}
              {isFailed && <Badge variant="red">Failed</Badge>}
            </div>
          </CardHeader>
          <CardContent>
            {/* Stage tracker — Loader2 for active, CheckCircle for done, XCircle for failed */}
            <div className="flex items-center gap-0 mb-5">
              {STAGES.map((stage, idx) => {
                const stageStatus = (ps?.[`stage_${stage.num}_status` as keyof typeof ps] as string) ?? 'pending'
                const isDone      = stageStatus === 'completed'
                const isFail      = stageStatus === 'failed' || (isFailed && currentStage === stage.num)
                const isActive    = currentStage === stage.num && !isDone && !isFail && !isComplete && !isFailed
                return (
                  <div key={stage.num} className="flex items-center flex-1">
                    <div className="flex flex-col items-center gap-1 flex-1">
                      {/* Circle with icon */}
                      <div className={cn(
                        'w-8 h-8 rounded-full border-2 flex items-center justify-center text-xs font-bold transition-all duration-300',
                        isDone   && 'bg-green-500/15  border-green-500  text-green-400',
                        isFail   && 'bg-red-500/15    border-red-500    text-red-400',
                        isActive && 'bg-brand-500/15  border-brand-500  text-brand-400',
                        !isDone && !isFail && !isActive && 'border-surface-border text-subtle',
                      )}>
                        {isDone   && <CheckCircle className="w-3.5 h-3.5" />}
                        {isFail   && <XCircle     className="w-3.5 h-3.5" />}
                        {isActive && <Loader2     className="w-3.5 h-3.5 animate-spin" />}
                        {!isDone && !isFail && !isActive && stage.num}
                      </div>

                      {/* Stage label + desc */}
                      <div className="text-center px-0.5">
                        <p className={cn(
                          'text-xs font-medium',
                          isDone   ? 'text-green-300' :
                          isFail   ? 'text-red-300'   :
                          isActive ? 'text-foreground' : 'text-subtle',
                        )}>
                          {stage.name}
                        </p>
                        <p className={cn(
                          'text-xs mt-0.5',
                          isActive ? 'text-brand-400' : 'text-subtle',
                        )}>
                          {isActive
                            ? <span className="flex items-center justify-center gap-0.5"><Clock className="w-2.5 h-2.5" />Processing</span>
                            : stage.desc}
                        </p>
                      </div>
                    </div>

                    {/* Connector line */}
                    {idx < STAGES.length - 1 && (
                      <div className={cn(
                        'h-0.5 flex-shrink-0 w-4 transition-colors duration-300',
                        isDone ? 'bg-green-500' : isActive ? 'bg-brand-500/40' : 'bg-surface-border',
                      )} />
                    )}
                  </div>
                )
              })}
            </div>

            {/* Stage 0: Classification */}
            {l1 && (
              <div className="border border-surface-border rounded-lg p-3 mb-3">
                <p className="text-xs font-semibold text-muted mb-2 uppercase tracking-wider">Stage 0 · Classification</p>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <span className="text-subtle">Issue L1</span>
                    <p className="text-foreground font-medium mt-0.5">{l1.issue_type_l1 ?? '—'}</p>
                  </div>
                  <div>
                    <span className="text-subtle">Issue L2</span>
                    <p className="text-foreground font-medium mt-0.5">{l1.issue_type_l2 ?? '—'}</p>
                  </div>
                  <div>
                    <span className="text-subtle">Confidence</span>
                    <p className="text-green-300 font-mono mt-0.5">
                      {l1.confidence_entailment ? formatPercent(l1.confidence_entailment) : '—'}
                    </p>
                  </div>
                  <div>
                    <span className="text-subtle">Image Required</span>
                    <p className="mt-0.5">
                      <Badge variant={l1.image_required ? 'amber' : 'gray'}>{l1.image_required ? 'Yes' : 'No'}</Badge>
                    </p>
                  </div>
                </div>
                {l1.reasoning && (
                  <p className="text-xs text-muted mt-2 italic">{l1.reasoning}</p>
                )}
              </div>
            )}

            {/* Stage 1: Evaluation */}
            {l2 && (
              <div className="border border-surface-border rounded-lg p-3 mb-3">
                <p className="text-xs font-semibold text-muted mb-2 uppercase tracking-wider">Stage 1 · Evaluation</p>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <span className="text-subtle">Action Code</span>
                    <p className="text-foreground font-mono font-medium mt-0.5">{l2.action_code ?? '—'}</p>
                  </div>
                  <div>
                    <span className="text-subtle">Gratification</span>
                    <p className="text-green-300 font-mono mt-0.5">
                      {l2.capped_gratification ? formatCurrency(l2.capped_gratification) : '—'}
                    </p>
                  </div>
                  <div>
                    <span className="text-subtle">Fraud Segment</span>
                    <p className="mt-0.5">{l2.fraud_segment ? <Badge variant="amber">{l2.fraud_segment}</Badge> : '—'}</p>
                  </div>
                  <div>
                    <span className="text-subtle">Greedy</span>
                    <p className="mt-0.5">
                      <Badge variant={l2.greedy_classification === 'GREEDY' ? 'red' : 'gray'}>
                        {l2.greedy_classification}
                      </Badge>
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Stage 2: Validation */}
            {l3 && (
              <div className="border border-surface-border rounded-lg p-3 mb-3">
                <p className="text-xs font-semibold text-muted mb-2 uppercase tracking-wider">Stage 2 · Validation</p>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <span className="text-subtle">Final Action</span>
                    <p className="text-brand-400 font-mono font-bold mt-0.5">{l3.final_action_code ?? '—'}</p>
                  </div>
                  <div>
                    <span className="text-subtle">Refund Amount</span>
                    <p className="text-green-300 font-mono mt-0.5">
                      {l3.final_refund_amount ? formatCurrency(l3.final_refund_amount) : '—'}
                    </p>
                  </div>
                  <div>
                    <span className="text-subtle">Validation Status</span>
                    <p className="mt-0.5">
                      {l3.logic_validation_status ? (
                        <StatusPill status={l3.logic_validation_status.toLowerCase()} />
                      ) : '—'}
                    </p>
                  </div>
                  <div>
                    <span className="text-subtle">Discrepancy</span>
                    <p className="mt-0.5">
                      <Badge variant={l3.discrepancy_detected ? 'red' : 'green'}>
                        {l3.discrepancy_detected ? `${l3.discrepancy_count} found` : 'None'}
                      </Badge>
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Link to full ticket */}
            {result.ticket_id != null && (
              <Link to={`/tickets/${result.ticket_id}`} className="w-full block mt-2">
                <Button variant="outline" size="sm" className="w-full">
                  <ExternalLink className="w-3.5 h-3.5" />
                  View Full Ticket #{result.ticket_id}
                </Button>
              </Link>
            )}
          </CardContent>
        </Card>
      )}

      {/* Raw payload */}
      {!!ticketDetail?.canonical_payload && (
        <Card>
          <CardHeader>
            <CardTitle>Canonical Payload</CardTitle>
          </CardHeader>
          <CardContent>
            <JsonViewer data={ticketDetail.canonical_payload} />
          </CardContent>
        </Card>
      )}
    </div>
  )
}
