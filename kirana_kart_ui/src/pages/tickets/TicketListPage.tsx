// src/pages/tickets/TicketListPage.tsx
// Progress column: 4-segment horizontal bar (h-2, gap-px) per pipeline stage.
// Colours: green-400 (completed) | brand-500 animate-pulse (active) |
//          red-400 (failed) | slate-700 (pending).
// API: ticketsApi.getList / ticketsApi.dispatch  (tickets.api.ts)
// Types: FdrawTicket (ticket.types.ts)

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card,CardContent } from '@/components/ui/Card'
import { Select } from '@/components/ui/Select'
import { StatusPill } from '@/components/common/StatusPill'
import { SearchInput } from '@/components/common/SearchInput'
import { PaginationBar } from '@/components/common/PaginationBar'
import { EmptyState } from '@/components/common/EmptyState'
import { Skeleton } from '@/components/ui/Skeleton'
import { ticketsApi } from '@/api/governance/tickets.api'
import { VALID_MODULES } from '@/lib/constants'
import { formatDate } from '@/lib/dates'
import { truncate } from '@/lib/utils'
import { cn } from '@/lib/cn'
import { Ticket } from 'lucide-react'

// Stage names for tooltip labels
const STAGE_NAMES = ['Classification', 'Evaluation', 'Validation', 'Dispatch'] as const

const PAGE_SIZE = 25

export default function TicketListPage() {
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [module, setModule] = useState('')
  const [stage, setStage] = useState('')

  const { data, isLoading, isError } = useQuery({
    queryKey: ['tickets', 'list', { page, search, module, stage }],
    queryFn: () => ticketsApi.getList({ page, limit: PAGE_SIZE, search: search || undefined, module: module || undefined, pipeline_stage: stage || undefined }).then((r) => r.data),
    refetchInterval: (query) => {
      const items = query.state.data?.items
      if (!items?.length) return false
      const hasActive = items.some(
        (t) => t.pipeline_stage === 'DISPATCHED' || t.pipeline_stage === 'IN_PROGRESS'
      )
      return hasActive ? 3000 : false
    },
  })

  const moduleOptions = [{ value: '', label: 'All Modules' }, ...VALID_MODULES.map((m) => ({ value: m, label: m.charAt(0).toUpperCase() + m.slice(1) }))]
  const stageOptions = [
    { value: '', label: 'All Stages' },
    { value: 'NEW', label: 'New' },
    { value: 'ENRICHED', label: 'Enriched' },
    { value: 'DISPATCHED', label: 'Dispatched' },
    { value: 'IN_PROGRESS', label: 'In Progress' },
    { value: 'COMPLETED', label: 'Completed' },
    { value: 'THREAD_RESOLVED', label: 'Resolved' },
    { value: 'FAILED', label: 'Failed' },
  ]

  return (
    <div>
      <PageHeader
        title="Tickets"
        subtitle="Browse and inspect all ingested tickets"
      />

      <div className="flex gap-3 mb-4">
        <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1) }} placeholder="Search by email or subject…" />
        <Select options={moduleOptions} value={module} onChange={(e) => { setModule(e.target.value); setPage(1) }} />
        <Select options={stageOptions} value={stage} onChange={(e) => { setStage(e.target.value); setPage(1) }} />
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-3">
              {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-10" />)}
            </div>
          ) : isError ? (
            <EmptyState title="Failed to load tickets" description="Could not reach the governance plane. Ensure the backend is running on port 8001." />
          ) : !data?.items?.length ? (
            <EmptyState icon={<Ticket className="w-8 h-8 text-subtle" />} title="No tickets found" description="Adjust filters or submit a ticket via Sandbox." />
          ) : (
            <>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-surface-border">
                    {['Ticket ID', 'Email', 'Subject', 'Module', 'Stage', 'Progress', 'Created'].map((h) => (
                      <th key={h} className="px-4 py-2.5 text-left text-xs font-medium text-subtle uppercase tracking-wider">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-border">
                  {data.items.map((ticket) => (
                    <tr key={ticket.sl} className="hover:bg-surface-card/50 transition-colors">
                      <td className="px-4 py-3">
                        <Link to={`/tickets/${ticket.ticket_id}`} className="font-mono text-brand-400 hover:text-brand-300">
                          #{ticket.ticket_id}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-muted text-xs">{ticket.cx_email ?? '—'}</td>
                      <td className="px-4 py-3 text-foreground max-w-xs">
                        <Link to={`/tickets/${ticket.ticket_id}`} className="hover:text-foreground truncate block">
                          {ticket.subject ? truncate(ticket.subject, 50) : '—'}
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        {ticket.module ? <span className="text-xs bg-surface-border/70 text-foreground px-1.5 py-0.5 rounded">{ticket.module}</span> : '—'}
                      </td>
                      <td className="px-4 py-3">
                        <StatusPill status={ticket.pipeline_stage} />
                      </td>
                      <td className="px-4 py-3">
                        {/* 4-segment progress bar — one segment per pipeline stage */}
                        <div className="flex gap-px w-24">
                          {([0, 1, 2, 3] as const).map((stageNum) => {
                            const ps     = ticket.processing_state
                            const status = ps?.[`stage_${stageNum}_status` as const] ?? 'pending'
                            const isDone = status === 'completed'
                            const isFail = status === 'failed'
                            const isActive = ps?.current_stage === stageNum && !isDone && !isFail
                            return (
                              <div
                                key={stageNum}
                                title={`Stage ${stageNum} · ${STAGE_NAMES[stageNum]}: ${status}`}
                                className={cn(
                                  'h-2 flex-1 transition-all duration-300',
                                  stageNum === 0 && 'rounded-l',
                                  stageNum === 3 && 'rounded-r',
                                  isDone   && 'bg-green-400',
                                  isFail   && 'bg-red-400',
                                  isActive && 'bg-brand-500 animate-pulse',
                                  !isDone && !isFail && !isActive && 'bg-surface-border',
                                )}
                              />
                            )
                          })}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-xs text-subtle">{ticket.created_at ? formatDate(ticket.created_at) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.total_pages > 1 && (
                <PaginationBar page={page} totalPages={data.total_pages} onPageChange={setPage} total={data.total} pageSize={PAGE_SIZE} />
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
