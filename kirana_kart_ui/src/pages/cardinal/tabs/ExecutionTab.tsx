// src/pages/cardinal/tabs/ExecutionTab.tsx
// ==========================================
// LLM Execution explorer — searchable/filterable paginated table of ticket executions.
// Clicking a row opens a slide-over detail drawer with the full 4-stage LLM chain.

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Card,CardContent } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/common/EmptyState'
import { PaginationBar } from '@/components/common/PaginationBar'
import { cardinalApi } from '@/api/governance/cardinal.api'
import type { ExecutionFilters } from '@/types/cardinal.types'
import { cn } from '@/lib/cn'
import { Cpu,X,ChevronRight } from 'lucide-react'

// ── Status badge helper ──────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const s = (status ?? '').toLowerCase()
  const map: Record<string, { label: string; cls: string }> = {
    complete:   { label: 'Done',       cls: 'bg-green-900/40 text-green-400 border-green-800/50' },
    completed:  { label: 'Done',       cls: 'bg-green-900/40 text-green-400 border-green-800/50' },
    success:    { label: 'Done',       cls: 'bg-green-900/40 text-green-400 border-green-800/50' },
    done:       { label: 'Done',       cls: 'bg-green-900/40 text-green-400 border-green-800/50' },
    failed:     { label: 'Failed',     cls: 'bg-red-900/40 text-red-400 border-red-800/50' },
    error:      { label: 'Error',      cls: 'bg-red-900/40 text-red-400 border-red-800/50' },
    running:    { label: 'Running',    cls: 'bg-amber-900/40 text-amber-400 border-amber-800/50' },
    processing: { label: 'Processing', cls: 'bg-amber-900/40 text-amber-400 border-amber-800/50' },
    pending:    { label: 'Pending',    cls: 'bg-slate-800/60 text-slate-400 border-slate-700/50' },
  }
  const resolved = map[s] ?? { label: status, cls: 'bg-slate-800/60 text-slate-400 border-slate-700/50' }
  return (
    <span className={cn('inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium border', resolved.cls)}>
      {resolved.label}
    </span>
  )
}

// ── Detail drawer ─────────────────────────────────────────────────────────────

function DetailSection({ title, data, colorClass }: {
  title: string
  data: Record<string, unknown> | null
  colorClass: string
}) {
  if (!data) return (
    <div className="mb-4">
      <p className={cn('text-xs font-semibold uppercase tracking-wider mb-1', colorClass)}>{title}</p>
      <p className="text-xs text-muted italic">No data available</p>
    </div>
  )

  // Pick a useful subset of fields to display (skip raw binary / huge fields)
  const skipKeys = new Set(['raw_response', 'raw_response_step1', 'raw_response_step2',
    'audit_log', 'canonical_payload', 'preprocessed_text', 'decision_trace',
    'discrepancy_details', 'metadata'])

  const entries = Object.entries(data).filter(([k]) => !skipKeys.has(k) && data[k] !== null && data[k] !== undefined)

  return (
    <div className="mb-5">
      <p className={cn('text-xs font-semibold uppercase tracking-wider mb-2', colorClass)}>{title}</p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        {entries.map(([key, val]) => (
          <div key={key} className="flex gap-1 text-xs">
            <span className="text-subtle shrink-0 min-w-0 truncate" style={{ maxWidth: 130 }} title={key}>
              {key.replace(/_/g, ' ')}:
            </span>
            <span className="text-foreground font-medium truncate" title={String(val)}>
              {typeof val === 'boolean' ? (val ? 'Yes' : 'No') : String(val)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function ExecutionDrawer({
  ticketId,
  onClose,
}: {
  ticketId: string
  onClose: () => void
}) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['cardinal', 'execution', ticketId],
    queryFn:  () => cardinalApi.executionDetail(ticketId).then((r) => r.data),
  })

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40 z-40"
        onClick={onClose}
      />

      {/* Drawer panel */}
      <div className="fixed inset-y-0 right-0 w-full max-w-2xl bg-surface-card border-l border-surface-border z-50 flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-surface-border shrink-0">
          <div>
            <p className="text-xs text-subtle uppercase tracking-wider">Execution Trace</p>
            <p className="font-semibold text-foreground font-mono text-sm mt-0.5">#{ticketId}</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md text-muted hover:text-foreground hover:bg-surface transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5">
          {isLoading && (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-20" />)}
            </div>
          )}

          {isError && (
            <EmptyState icon={<Cpu className="w-8 h-8 text-subtle" />} title="Could not load execution trace" description="Try again or check governance logs." />
          )}

          {data && (
            <div>
              {/* Raw ticket summary */}
              <div className="mb-5 p-3 rounded-lg bg-surface border border-surface-border text-xs space-y-1">
                <div className="flex gap-2">
                  <span className="text-subtle">Subject:</span>
                  <span className="text-foreground font-medium">{String(data.raw_ticket?.subject ?? '—')}</span>
                </div>
                <div className="flex gap-2">
                  <span className="text-subtle">Email:</span>
                  <span className="text-foreground">{String(data.raw_ticket?.cx_email ?? '—')}</span>
                </div>
                <div className="flex gap-2">
                  <span className="text-subtle">Source / Module:</span>
                  <span className="text-foreground">{String(data.raw_ticket?.source ?? '—')} / {String(data.raw_ticket?.module ?? '—')}</span>
                </div>
                <div className="flex gap-2">
                  <span className="text-subtle">Created:</span>
                  <span className="text-foreground">{String(data.raw_ticket?.created_at ?? '—')}</span>
                </div>
              </div>

              {/* Phase state pills */}
              {data.phase_states.length > 0 && (
                <div className="mb-5">
                  <p className="text-xs font-semibold text-subtle uppercase tracking-wider mb-2">Pipeline Phases</p>
                  <div className="flex flex-wrap gap-2">
                    {data.phase_states.map((ps, i) => {
                      const stageStr = String(ps.current_stage ?? i)
                      return (
                        <span key={i} className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-surface border border-surface-border text-xs text-foreground">
                          {stageStr}
                        </span>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* LLM outputs */}
              <div className="space-y-1 divide-y divide-surface-border">
                <div className="py-3">
                  <DetailSection
                    title="Stage 1 — Classification (llm_output_1)"
                    data={data.llm_output_1}
                    colorClass="text-amber-400"
                  />
                </div>
                <div className="py-3">
                  <DetailSection
                    title="Stage 2 — Evaluation (llm_output_2)"
                    data={data.llm_output_2}
                    colorClass="text-blue-400"
                  />
                </div>
                <div className="py-3">
                  <DetailSection
                    title="Stage 3 — Validation (llm_output_3)"
                    data={data.llm_output_3}
                    colorClass="text-purple-400"
                  />
                </div>
                <div className="py-3">
                  <DetailSection
                    title="Stage 4 — Dispatch Summary"
                    data={data.summary}
                    colorClass="text-green-400"
                  />
                </div>
              </div>

              {/* Metrics */}
              {data.metrics && (
                <div className="mt-4 p-3 rounded-lg bg-surface border border-surface-border">
                  <p className="text-xs font-semibold text-subtle uppercase tracking-wider mb-2">Processing Metrics</p>
                  <div className="flex flex-wrap gap-4 text-xs">
                    <div>
                      <span className="text-subtle">Duration:</span>
                      <span className="font-medium text-foreground ml-1">
                        {data.metrics.duration_ms != null
                          ? `${(Number(data.metrics.duration_ms) / 1000).toFixed(2)}s`
                          : '—'}
                      </span>
                    </div>
                    <div>
                      <span className="text-subtle">Total tokens:</span>
                      <span className="font-medium text-foreground ml-1">{String(data.metrics.total_tokens ?? '—')}</span>
                    </div>
                    <div>
                      <span className="text-subtle">Status:</span>
                      <span className="font-medium text-foreground ml-1">{String(data.metrics.overall_status ?? '—')}</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Audit events */}
              {data.audit_events.length > 0 && (
                <div className="mt-4">
                  <p className="text-xs font-semibold text-subtle uppercase tracking-wider mb-2">Audit Events</p>
                  <div className="space-y-1 max-h-48 overflow-y-auto">
                    {data.audit_events.map((ev, i) => (
                      <div key={i} className="flex items-start gap-2 text-xs p-2 rounded-md bg-surface">
                        <span className="text-subtle shrink-0 w-24 truncate">{String(ev.stage_name ?? '—')}</span>
                        <span className={cn(
                          'shrink-0 font-medium',
                          String(ev.event_type).includes('error') || String(ev.event_type).includes('fail')
                            ? 'text-red-400' : 'text-green-400'
                        )}>{String(ev.event_type ?? '—')}</span>
                        <span className="text-muted truncate">{String(ev.message ?? '')}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  )
}

// ── Main execution table ──────────────────────────────────────────────────────

const PAGE_SIZE = 50

export function ExecutionTab() {
  const [filters, setFilters] = useState<ExecutionFilters>({ page: 1, size: PAGE_SIZE })
  const [search,  setSearch]  = useState('')
  const [source,  setSource]  = useState('')
  const [status,  setStatus]  = useState('')
  const [module,  setModule]  = useState('')
  const [selectedTicket, setSelectedTicket] = useState<string | null>(null)

  // Debounce search a bit — just apply on Enter or blur
  const applyFilters = () => {
    setFilters((f) => ({
      ...f,
      page: 1,
      search:  search  || undefined,
      source:  source  || undefined,
      status:  status  || undefined,
      module:  module  || undefined,
    }))
  }

  const clearFilters = () => {
    setSearch('')
    setSource('')
    setStatus('')
    setModule('')
    setFilters({ page: 1, size: PAGE_SIZE })
  }

  const { data, isLoading, isError } = useQuery({
    queryKey: ['cardinal', 'executions', filters],
    queryFn:  () => cardinalApi.executions(filters).then((r) => r.data),
  })

  const hasFilters = !!(search || source || status || module)

  return (
    <div className="space-y-4">
      {/* ── Filters ─────────────────────────────────────── */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap gap-2 items-end">
            <div className="flex-1 min-w-[180px]">
              <label className="text-xs text-subtle mb-1 block">Search ticket / email</label>
              <Input
                placeholder="Ticket ID or email…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && applyFilters()}
                className="h-8 text-sm"
              />
            </div>

            <div className="w-32">
              <label className="text-xs text-subtle mb-1 block">Source</label>
              <Select
                value={source}
                onChange={(e) => setSource(e.target.value)}
                className="h-8 text-sm"
                placeholder="All sources"
                options={[
                  { value: 'gmail',     label: 'Gmail' },
                  { value: 'outlook',   label: 'Outlook' },
                  { value: 'smtp',      label: 'SMTP' },
                  { value: 'api',       label: 'API' },
                  { value: 'freshdesk', label: 'Freshdesk' },
                ]}
              />
            </div>

            <div className="w-32">
              <label className="text-xs text-subtle mb-1 block">Status</label>
              <Select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                className="h-8 text-sm"
                placeholder="All statuses"
                options={[
                  { value: 'complete', label: 'Complete' },
                  { value: 'failed',   label: 'Failed' },
                  { value: 'running',  label: 'Running' },
                  { value: 'pending',  label: 'Pending' },
                ]}
              />
            </div>

            <div className="w-36">
              <label className="text-xs text-subtle mb-1 block">Module</label>
              <Input
                placeholder="delivery…"
                value={module}
                onChange={(e) => setModule(e.target.value)}
                className="h-8 text-sm"
              />
            </div>

            <Button size="sm" onClick={applyFilters} className="h-8">Apply</Button>
            {hasFilters && (
              <Button size="sm" variant="ghost" onClick={clearFilters} className="h-8">
                <X className="w-3.5 h-3.5 mr-1" /> Clear
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ── Table ───────────────────────────────────────── */}
      <Card>
        {isLoading && (
          <div className="p-4 space-y-2">
            {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-10" />)}
          </div>
        )}

        {isError && (
          <div className="p-6">
            <EmptyState icon={<Cpu className="w-8 h-8 text-subtle" />} title="Could not load executions" description="Check that the governance API is running." />
          </div>
        )}

        {!isLoading && !isError && data && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-surface-border text-left">
                    {['Ticket #', 'Source', 'Module', 'Status', 'Action', 'Time', 'Created', ''].map((h) => (
                      <th key={h} className="px-4 py-2.5 text-xs font-semibold text-subtle uppercase tracking-wider whitespace-nowrap">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.items.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-4 py-8 text-center text-muted text-sm">
                        No executions match the current filters.
                      </td>
                    </tr>
                  ) : (
                    data.items.map((row) => (
                      <tr
                        key={row.ticket_id}
                        className="border-b border-surface-border hover:bg-surface/40 transition-colors cursor-pointer"
                        onClick={() => setSelectedTicket(row.ticket_id)}
                      >
                        <td className="px-4 py-2.5">
                          <span className="font-mono text-brand-400 text-xs">#{row.ticket_id}</span>
                          {row.cx_email && (
                            <p className="text-xs text-subtle truncate max-w-[140px]" title={row.cx_email}>{row.cx_email}</p>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-muted">{row.source || '—'}</td>
                        <td className="px-4 py-2.5 text-xs text-muted">{row.module || '—'}</td>
                        <td className="px-4 py-2.5"><StatusBadge status={row.status} /></td>
                        <td className="px-4 py-2.5 text-xs text-foreground font-medium">
                          {row.action_code ?? '—'}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-muted whitespace-nowrap">
                          {row.processing_ms != null
                            ? row.processing_ms >= 1000
                              ? `${(row.processing_ms / 1000).toFixed(1)}s`
                              : `${row.processing_ms}ms`
                            : '—'}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-muted whitespace-nowrap">
                          {row.created_at
                            ? new Date(row.created_at).toLocaleDateString()
                            : '—'}
                        </td>
                        <td className="px-4 py-2.5">
                          <ChevronRight className="w-4 h-4 text-muted" />
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {data.total > 0 && (
              <PaginationBar
                page={filters.page}
                totalPages={data.pages}
                total={data.total}
                pageSize={PAGE_SIZE}
                onPageChange={(p) => setFilters((f) => ({ ...f, page: p }))}
              />
            )}
          </>
        )}
      </Card>

      {/* ── Detail drawer ────────────────────────────────── */}
      {selectedTicket && (
        <ExecutionDrawer
          ticketId={selectedTicket}
          onClose={() => setSelectedTicket(null)}
        />
      )}
    </div>
  )
}
