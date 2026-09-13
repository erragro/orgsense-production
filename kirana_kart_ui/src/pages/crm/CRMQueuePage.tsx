// CRMQueuePage.tsx — Freshdesk-like CRM queue with filters, bulk actions, SLA badges
import { useState,useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery,useMutation,useQueryClient } from '@tanstack/react-query'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card,CardContent } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Spinner } from '@/components/ui/Spinner'
import { EmptyState } from '@/components/common/EmptyState'
import { PaginationBar } from '@/components/common/PaginationBar'
import { crmApi,computeSLAUrgency,formatMinutes } from '@/api/governance/crm.api'
import type {
QueueItem,QueueFilters,QueueType,QueueStatus,SavedView
} from '@/types/crm.types'
import {
PRIORITY_COLORS as PC,
QUEUE_TYPE_LABELS as QTL,STATUS_LABELS as SL,STATUS_COLORS as SC
} from '@/types/crm.types'
import { useAuthStore } from '@/stores/auth.store'
import { hasPermission } from '@/lib/access'
import { cn } from '@/lib/cn'
import {
Filter,RefreshCw,Users,Clock,CheckSquare,Square,BookmarkPlus,Trash2
} from 'lucide-react'

const QUEUE_TYPE_OPTIONS = [
  { value: '', label: 'All Queues' },
  { value: 'STANDARD_REVIEW', label: 'Standard Review' },
  { value: 'SENIOR_REVIEW', label: 'Senior Review' },
  { value: 'SLA_BREACH_REVIEW', label: 'SLA Breach' },
  { value: 'ESCALATION_QUEUE', label: 'Escalation' },
  { value: 'MANUAL_REVIEW', label: 'Manual Review' },
]

const STATUS_OPTIONS = [
  { value: '', label: 'All Statuses' },
  { value: 'OPEN', label: 'Open' },
  { value: 'IN_PROGRESS', label: 'In Progress' },
  { value: 'PENDING_CUSTOMER', label: 'Pending Customer' },
  { value: 'ESCALATED', label: 'Escalated' },
  { value: 'RESOLVED', label: 'Resolved' },
  { value: 'CLOSED', label: 'Closed' },
]

const PRIORITY_OPTIONS = [
  { value: '', label: 'All Priorities' },
  { value: '1', label: 'Critical' },
  { value: '2', label: 'High' },
  { value: '3', label: 'Normal' },
  { value: '4', label: 'Low' },
]

function SLABadge({ item }: { item: QueueItem }) {
  const { urgency, minutesRemaining } = computeSLAUrgency(item.sla_due_at, item.sla_breached)
  const color = urgency === 'red' ? 'text-red-600' : urgency === 'amber' ? 'text-amber-600' : 'text-green-600'
  const bg = urgency === 'red' ? 'bg-red-50 border-red-200' : urgency === 'amber' ? 'bg-amber-50 border-amber-200' : 'bg-green-50 border-green-200'
  return (
    <span className={cn('inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-xs font-medium', bg, color)}>
      <Clock className="w-3 h-3" />
      {formatMinutes(minutesRemaining)}
    </span>
  )
}

export default function CRMQueuePage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { user } = useAuthStore()
  const isAdmin = hasPermission(user, 'crm', 'admin')

  const [filters, setFilters] = useState<QueueFilters>({
    page: 1, limit: 25, sort_by: 'sla_due_at', sort_dir: 'asc',
  })
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [showFilters, setShowFilters] = useState(false)
  const [bulkAction, setBulkAction] = useState('')
  const [bulkAssignee, setBulkAssignee] = useState<number | null>(null)
  const [bulkReason, setBulkReason] = useState('')
  const [bulkStatus, setBulkStatus] = useState('')
  const [saveViewName, setSaveViewName] = useState('')
  const [showSaveView, setShowSaveView] = useState(false)

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['crm-queue', filters],
    queryFn: () => crmApi.getQueue(filters).then(r => r.data),
    refetchInterval: 30_000,
  })

  const { data: agents } = useQuery({
    queryKey: ['crm-agents'],
    queryFn: () => crmApi.getAgents().then(r => r.data),
  })

  const { data: savedViews, refetch: refetchViews } = useQuery({
    queryKey: ['crm-saved-views'],
    queryFn: () => crmApi.getSavedViews().then(r => r.data),
  })

  useQuery({
    queryKey: ['crm-tags'],
    queryFn: () => crmApi.getTags().then(r => r.data),
  })

  const bulkAssignMut = useMutation({
    mutationFn: (ids: number[]) => crmApi.bulkAssign(ids, bulkAssignee!),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['crm-queue'] }); setSelected(new Set()); setBulkAction('') },
  })

  const bulkEscalateMut = useMutation({
    mutationFn: (ids: number[]) => crmApi.bulkEscalate(ids, bulkReason),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['crm-queue'] }); setSelected(new Set()); setBulkAction('') },
  })

  const bulkCloseMut = useMutation({
    mutationFn: (ids: number[]) => crmApi.bulkClose(ids, bulkReason),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['crm-queue'] }); setSelected(new Set()); setBulkAction('') },
  })

  const bulkStatusMut = useMutation({
    mutationFn: (ids: number[]) => crmApi.bulkStatus(ids, bulkStatus),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['crm-queue'] }); setSelected(new Set()); setBulkAction('') },
  })

  const saveViewMut = useMutation({
    mutationFn: () => crmApi.saveView({ name: saveViewName, filters: filters as Record<string, unknown>, is_default: false }),
    onSuccess: () => { refetchViews(); setShowSaveView(false); setSaveViewName('') },
  })

  const deleteViewMut = useMutation({
    mutationFn: (id: number) => crmApi.deleteView(id),
    onSuccess: () => refetchViews(),
  })

  const items = data?.items ?? []
  const total = data?.total ?? 0
  const pages = data?.pages ?? 1

  const allSelected = items.length > 0 && items.every(i => selected.has(i.id))
  const someSelected = selected.size > 0

  const toggleAll = () => {
    if (allSelected) setSelected(new Set())
    else setSelected(new Set(items.map(i => i.id)))
  }

  const toggleOne = (id: number) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }

  const applyFilter = useCallback((patch: Partial<QueueFilters>) => {
    setFilters(prev => ({ ...prev, ...patch, page: 1 }))
  }, [])

  const applyView = (view: SavedView) => {
    setFilters({ ...view.filters as QueueFilters, page: 1 })
  }

  const runBulkAction = () => {
    const ids = Array.from(selected)
    if (!ids.length) return
    if (bulkAction === 'assign' && bulkAssignee) bulkAssignMut.mutate(ids)
    else if (bulkAction === 'escalate' && bulkReason) bulkEscalateMut.mutate(ids)
    else if (bulkAction === 'close' && bulkReason) bulkCloseMut.mutate(ids)
    else if (bulkAction === 'status' && bulkStatus) bulkStatusMut.mutate(ids)
  }

  const agentOptions = [
    { value: '', label: 'All Agents' },
    ...(agents ?? []).map(a => ({ value: String(a.id), label: a.full_name })),
  ]

  return (
    <div className="p-6 max-w-full">
      <PageHeader
        title="CRM Queue"
        subtitle={`${total} tickets${isFetching ? ' · refreshing…' : ''}`}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => refetch()}>
              <RefreshCw className={cn('w-4 h-4', isFetching && 'animate-spin')} />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setShowFilters(!showFilters)}>
              <Filter className="w-4 h-4 mr-1" /> Filters
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setShowSaveView(!showSaveView)}>
              <BookmarkPlus className="w-4 h-4 mr-1" /> Save View
            </Button>
          </div>
        }
      />

      {/* Saved Views */}
      {savedViews && savedViews.length > 0 && (
        <div className="flex gap-2 mb-4 flex-wrap">
          {savedViews.map(view => (
            <div key={view.id} className="flex items-center gap-1 bg-surface border border-surface-border rounded px-2 py-1 text-xs">
              <button onClick={() => applyView(view)} className="text-brand-400 hover:text-brand-300 font-medium">
                {view.name}
              </button>
              {isAdmin && (
                <button onClick={() => deleteViewMut.mutate(view.id)} className="text-muted hover:text-red-400">
                  <Trash2 className="w-3 h-3" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Save View Input */}
      {showSaveView && (
        <Card className="mb-4">
          <CardContent className="p-3 flex items-center gap-2">
            <Input
              placeholder="View name…"
              value={saveViewName}
              onChange={e => setSaveViewName(e.target.value)}
              className="h-8 text-sm w-48"
            />
            <Button size="sm" onClick={() => saveViewMut.mutate()} disabled={!saveViewName || saveViewMut.isPending}>
              Save
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setShowSaveView(false)}>Cancel</Button>
          </CardContent>
        </Card>
      )}

      {/* Filters */}
      {showFilters && (
        <Card className="mb-4">
          <CardContent className="p-4 grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
            <Input
              placeholder="Search tickets…"
              value={filters.search ?? ''}
              onChange={e => applyFilter({ search: e.target.value })}
              className="h-8 text-sm"
            />
            <Select
              options={QUEUE_TYPE_OPTIONS}
              value={filters.queue_type ?? ''}
              onChange={e => applyFilter({ queue_type: (e.target.value as QueueType) || undefined })}
            />
            <Select
              options={STATUS_OPTIONS}
              value={filters.status ?? ''}
              onChange={e => applyFilter({ status: (e.target.value as QueueStatus) || undefined })}
            />
            <Select
              options={PRIORITY_OPTIONS}
              value={filters.priority != null ? String(filters.priority) : ''}
              onChange={e => applyFilter({ priority: e.target.value ? Number(e.target.value) : undefined })}
            />
            <Select
              options={agentOptions}
              value={filters.assigned_to != null ? String(filters.assigned_to) : ''}
              onChange={e => applyFilter({ assigned_to: e.target.value ? Number(e.target.value) : undefined })}
            />
            <Select
              options={[
                { value: '', label: 'SLA: All' },
                { value: 'true', label: 'SLA Breached' },
                { value: 'false', label: 'SLA OK' },
              ]}
              value={filters.sla_breached != null ? String(filters.sla_breached) : ''}
              onChange={e => applyFilter({ sla_breached: e.target.value === '' ? undefined : e.target.value === 'true' })}
            />
            <div className="flex gap-2 col-span-2">
              <Select
                options={[
                  { value: 'sla_due_at', label: 'Sort: SLA' },
                  { value: 'created_at', label: 'Sort: Created' },
                  { value: 'priority', label: 'Sort: Priority' },
                  { value: 'updated_at', label: 'Sort: Updated' },
                ]}
                value={filters.sort_by ?? 'sla_due_at'}
                onChange={e => applyFilter({ sort_by: e.target.value })}
              />
              <Select
                options={[
                  { value: 'asc', label: 'Asc' },
                  { value: 'desc', label: 'Desc' },
                ]}
                value={filters.sort_dir ?? 'asc'}
                onChange={e => applyFilter({ sort_dir: e.target.value as 'asc' | 'desc' })}
              />
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setFilters({ page: 1, limit: 25, sort_by: 'sla_due_at', sort_dir: 'asc' })}
            >
              Clear Filters
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Bulk Actions Bar */}
      {someSelected && isAdmin && (
        <Card className="mb-4 border-brand-600/40 bg-brand-600/5">
          <CardContent className="p-3 flex items-center gap-3 flex-wrap">
            <span className="text-sm font-medium text-foreground">{selected.size} selected</span>
            <Select
              options={[
                { value: '', label: 'Choose action…' },
                { value: 'assign', label: 'Assign' },
                { value: 'escalate', label: 'Escalate' },
                { value: 'close', label: 'Close' },
                { value: 'status', label: 'Change Status' },
              ]}
              value={bulkAction}
              onChange={e => { setBulkAction(e.target.value); setBulkReason(''); setBulkStatus(''); setBulkAssignee(null) }}
            />
            {bulkAction === 'assign' && (
              <Select
                options={agentOptions.slice(1)}
                value={bulkAssignee != null ? String(bulkAssignee) : ''}
                onChange={e => setBulkAssignee(e.target.value ? Number(e.target.value) : null)}
              />
            )}
            {(bulkAction === 'escalate' || bulkAction === 'close') && (
              <Input
                placeholder="Reason…"
                value={bulkReason}
                onChange={e => setBulkReason(e.target.value)}
                className="h-8 text-sm w-48"
              />
            )}
            {bulkAction === 'status' && (
              <Select
                options={STATUS_OPTIONS.slice(1)}
                value={bulkStatus}
                onChange={e => setBulkStatus(e.target.value)}
              />
            )}
            <Button
              size="sm"
              onClick={runBulkAction}
              disabled={
                !bulkAction ||
                (bulkAction === 'assign' && !bulkAssignee) ||
                ((bulkAction === 'escalate' || bulkAction === 'close') && !bulkReason) ||
                (bulkAction === 'status' && !bulkStatus)
              }
            >
              Apply
            </Button>
            <Button variant="ghost" size="sm" onClick={() => { setSelected(new Set()); setBulkAction('') }}>
              Cancel
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Table */}
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-border bg-surface/50">
                {isAdmin && (
                  <th className="p-3 w-8">
                    <button onClick={toggleAll}>
                      {allSelected
                        ? <CheckSquare className="w-4 h-4 text-brand-500" />
                        : <Square className="w-4 h-4 text-muted" />
                      }
                    </button>
                  </th>
                )}
                <th className="p-3 text-left text-xs font-semibold text-subtle uppercase tracking-wide w-8">P</th>
                <th className="p-3 text-left text-xs font-semibold text-subtle uppercase tracking-wide">Ticket</th>
                <th className="p-3 text-left text-xs font-semibold text-subtle uppercase tracking-wide">Queue</th>
                <th className="p-3 text-left text-xs font-semibold text-subtle uppercase tracking-wide">Status</th>
                <th className="p-3 text-left text-xs font-semibold text-subtle uppercase tracking-wide">AI Action</th>
                <th className="p-3 text-left text-xs font-semibold text-subtle uppercase tracking-wide">SLA</th>
                <th className="p-3 text-left text-xs font-semibold text-subtle uppercase tracking-wide">Assignee</th>
                <th className="p-3 text-left text-xs font-semibold text-subtle uppercase tracking-wide">Tags</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td colSpan={9} className="p-8 text-center">
                    <Spinner size="md" />
                  </td>
                </tr>
              )}
              {!isLoading && items.length === 0 && (
                <tr>
                  <td colSpan={9} className="p-8">
                    <EmptyState title="No tickets" description="No tickets match your current filters." />
                  </td>
                </tr>
              )}
              {items.map(item => (
                <tr
                  key={item.id}
                  className={cn(
                    'border-b border-surface-border hover:bg-surface/40 cursor-pointer transition-colors',
                    selected.has(item.id) && 'bg-brand-600/5'
                  )}
                  onClick={() => navigate(`/crm/ticket/${item.id}`)}
                >
                  {isAdmin && (
                    <td className="p-3 w-8" onClick={e => { e.stopPropagation(); toggleOne(item.id) }}>
                      {selected.has(item.id)
                        ? <CheckSquare className="w-4 h-4 text-brand-500" />
                        : <Square className="w-4 h-4 text-muted" />
                      }
                    </td>
                  )}
                  <td className="p-3">
                    <span className={cn('text-xs font-bold px-1.5 py-0.5 rounded', PC[item.priority])}>
                      {item.priority}
                    </span>
                  </td>
                  <td className="p-3 max-w-[280px]">
                    <div className="flex flex-col gap-0.5">
                      <span className="font-medium text-foreground truncate">
                        {item.subject || `Ticket #${item.ticket_id}`}
                      </span>
                      <div className="flex items-center gap-2 text-xs text-muted">
                        <span>#{item.ticket_id}</span>
                        {item.cx_email && <span className="truncate max-w-[120px]">{item.cx_email}</span>}
                        {item.customer_segment && (
                          <Badge variant="purple" size="sm">{item.customer_segment}</Badge>
                        )}
                      </div>
                      {item.viewing_agent_name && (
                        <span className="text-xs text-amber-500 flex items-center gap-1">
                          <Users className="w-3 h-3" /> Being viewed by {item.viewing_agent_name}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="p-3">
                    <Badge variant="blue" size="sm">{QTL[item.queue_type] ?? item.queue_type}</Badge>
                  </td>
                  <td className="p-3">
                    <span className={cn('text-xs px-2 py-0.5 rounded-full font-medium', SC[item.status])}>
                      {SL[item.status] ?? item.status}
                    </span>
                  </td>
                  <td className="p-3">
                    {item.ai_action_code ? (
                      <div className="flex flex-col gap-0.5">
                        <span className="text-xs font-mono text-brand-400">{item.ai_action_code}</span>
                        {item.ai_refund_amount != null && (
                          <span className="text-xs text-green-400">₹{item.ai_refund_amount.toLocaleString()}</span>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-muted">—</span>
                    )}
                  </td>
                  <td className="p-3">
                    <SLABadge item={item} />
                  </td>
                  <td className="p-3">
                    {item.assigned_to_name ? (
                      <div className="flex items-center gap-1.5">
                        <div className="w-6 h-6 rounded-full bg-brand-600/30 flex items-center justify-center text-xs font-bold text-brand-300">
                          {item.assigned_to_name[0]}
                        </div>
                        <span className="text-xs truncate max-w-[80px]">{item.assigned_to_name}</span>
                      </div>
                    ) : (
                      <span className="text-xs text-muted">Unassigned</span>
                    )}
                  </td>
                  <td className="p-3">
                    <div className="flex gap-1 flex-wrap">
                      {item.tags.slice(0, 3).map(tag => (
                        <span
                          key={tag.id}
                          className="text-xs px-1.5 py-0.5 rounded"
                          style={{ backgroundColor: tag.color + '22', color: tag.color, border: `1px solid ${tag.color}44` }}
                        >
                          {tag.name}
                        </span>
                      ))}
                      {item.tags.length > 3 && (
                        <span className="text-xs text-muted">+{item.tags.length - 3}</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {pages > 1 && (
          <div className="p-4 border-t border-surface-border">
            <PaginationBar
              page={filters.page ?? 1}
              totalPages={pages}
              onPageChange={p => setFilters(prev => ({ ...prev, page: p }))}
            />
          </div>
        )}
      </Card>
    </div>
  )
}
