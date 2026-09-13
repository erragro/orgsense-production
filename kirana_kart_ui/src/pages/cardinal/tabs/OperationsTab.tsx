// src/pages/cardinal/tabs/OperationsTab.tsx
// ==========================================
// Operations tab — recent audit log + manual ticket reprocess tool.
// The reprocess form is only shown to users with cardinal.admin permission.

import { useState } from 'react'
import { useQuery,useMutation,useQueryClient } from '@tanstack/react-query'
import { Card,CardContent,CardHeader,CardTitle } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/common/EmptyState'
import { PaginationBar } from '@/components/common/PaginationBar'
import { cardinalApi } from '@/api/governance/cardinal.api'
import { useAuthStore } from '@/stores/auth.store'
import { hasPermission } from '@/lib/access'
import { toast } from '@/stores/toast.store'
import type { AuditFilters } from '@/types/cardinal.types'
import { cn } from '@/lib/cn'
import { Wrench,RefreshCw,AlertTriangle,CheckCircle } from 'lucide-react'

// ── Audit log table ──────────────────────────────────────────────────────────

function AuditLogPanel() {
  const [filters, setFilters] = useState<AuditFilters>({ page: 1, size: 50 })

  const { data, isLoading, isError } = useQuery({
    queryKey: ['cardinal', 'audit', filters],
    queryFn:  () => cardinalApi.audit(filters).then((r) => r.data),
    refetchInterval: 30_000,
  })

  const eventTypeColor = (t: string | null) => {
    const lower = (t ?? '').toLowerCase()
    if (lower.includes('error') || lower.includes('fail')) return 'text-red-400'
    if (lower.includes('warn')) return 'text-amber-400'
    return 'text-green-400'
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <RefreshCw className="w-3.5 h-3.5" />
          Recent Audit Log
          <span className="text-xs text-subtle font-normal">(auto-refreshes every 30s)</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading && (
          <div className="p-4 space-y-2">
            {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-9" />)}
          </div>
        )}

        {isError && (
          <div className="p-6">
            <EmptyState icon={<Wrench className="w-8 h-8 text-subtle" />} title="Could not load audit log" description="Check governance logs." />
          </div>
        )}

        {!isLoading && !isError && data && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-surface-border text-left">
                    {['Timestamp', 'Stage', 'Event Type', 'Ticket', 'Message'].map((h) => (
                      <th key={h} className="px-4 py-2.5 text-xs font-semibold text-subtle uppercase tracking-wider whitespace-nowrap">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.items.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-8 text-center text-muted text-sm">
                        No audit events found.
                      </td>
                    </tr>
                  ) : (
                    data.items.map((ev) => (
                      <tr key={ev.id} className="border-b border-surface-border hover:bg-surface/30 transition-colors">
                        <td className="px-4 py-2.5 text-xs text-muted whitespace-nowrap">
                          {ev.event_time ? new Date(ev.event_time).toLocaleString() : '—'}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-muted">{ev.stage_name ?? '—'}</td>
                        <td className="px-4 py-2.5">
                          <span className={cn('text-xs font-medium', eventTypeColor(ev.event_type))}>
                            {ev.event_type ?? '—'}
                          </span>
                        </td>
                        <td className="px-4 py-2.5">
                          {ev.ticket_id
                            ? <span className="font-mono text-brand-400 text-xs">#{ev.ticket_id}</span>
                            : <span className="text-muted text-xs">—</span>}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-muted max-w-xs truncate" title={ev.message ?? ''}>
                          {ev.message ?? '—'}
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
                pageSize={50}
                onPageChange={(p) => setFilters((f) => ({ ...f, page: p }))}
              />
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

// ── Reprocess panel ──────────────────────────────────────────────────────────

function ReprocessPanel() {
  const [ticketId,  setTicketId]  = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [result,    setResult]    = useState<{ ok: boolean; message: string } | null>(null)
  const qc = useQueryClient()

  const mutation = useMutation({
    mutationFn: (id: string) => cardinalApi.reprocess(id).then((r) => r.data),
    onSuccess: (data) => {
      setResult({ ok: true, message: data.message ?? `Requeued — execution: ${data.execution_id ?? 'n/a'}` })
      setTicketId('')
      setConfirmed(false)
      qc.invalidateQueries({ queryKey: ['cardinal', 'executions'] })
      qc.invalidateQueries({ queryKey: ['cardinal', 'audit'] })
      toast.success('Ticket requeued', 'The ticket has been re-submitted to the Cardinal pipeline.')
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Reprocess failed'
      setResult({ ok: false, message: msg })
      toast.error('Reprocess failed', msg)
    },
  })

  const handleSubmit = () => {
    if (!ticketId.trim()) return
    if (!confirmed) {
      setConfirmed(true)
      return
    }
    mutation.mutate(ticketId.trim())
    setConfirmed(false)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <Wrench className="w-3.5 h-3.5" />
          Reprocess Ticket
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 space-y-4">
        {/* Warning banner */}
        <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-950/30 border border-amber-800/40 text-xs text-amber-300">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            Re-submitting a ticket runs it through the <strong>full Cardinal pipeline</strong> again — validation, dedup, enrichment, and LLM classification. Use this for tickets that failed or need re-evaluation.
          </span>
        </div>

        {/* Input + button */}
        <div className="flex gap-2 items-end">
          <div className="flex-1">
            <label className="text-xs text-subtle mb-1 block">Ticket ID</label>
            <Input
              placeholder="e.g. TKT-12345"
              value={ticketId}
              onChange={(e) => { setTicketId(e.target.value); setConfirmed(false); setResult(null) }}
              onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
              className="h-9 text-sm font-mono"
            />
          </div>
          <Button
            onClick={handleSubmit}
            disabled={!ticketId.trim() || mutation.isPending}
            variant={confirmed ? 'danger' : 'primary'}
            size="sm"
            className="h-9 whitespace-nowrap"
          >
            {mutation.isPending
              ? 'Submitting…'
              : confirmed
              ? '⚠ Confirm Reprocess'
              : 'Reprocess →'}
          </Button>
        </div>

        {confirmed && !mutation.isPending && (
          <p className="text-xs text-amber-400">
            Click <strong>Confirm Reprocess</strong> above to re-submit ticket <code className="font-mono">{ticketId}</code>.
          </p>
        )}

        {/* Result */}
        {result && (
          <div className={cn(
            'flex items-start gap-2 p-3 rounded-lg border text-xs',
            result.ok
              ? 'bg-green-950/30 border-green-800/40 text-green-300'
              : 'bg-red-950/30 border-red-800/40 text-red-300',
          )}>
            {result.ok
              ? <CheckCircle className="w-4 h-4 shrink-0 mt-0.5" />
              : <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />}
            <span>{result.message}</span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ── Main ─────────────────────────────────────────────────────────────────────

export function OperationsTab() {
  const { user } = useAuthStore()
  const canAdmin = hasPermission(user, 'cardinal', 'admin')

  return (
    <div className="space-y-6">
      {/* Audit log — visible to all cardinal.view users */}
      <AuditLogPanel />

      {/* Reprocess tool — admin only */}
      {canAdmin ? (
        <ReprocessPanel />
      ) : (
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted">
              <strong>Reprocess Tool</strong> is restricted to users with <code className="font-mono text-brand-400">cardinal.admin</code> permission.
              Ask a super-admin to grant you admin access on the Cardinal module.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
