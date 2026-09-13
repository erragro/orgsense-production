// CRMWorkViewPage.tsx — Full Freshdesk-like ticket work view
// Layout: Left panel (customer 360 + metadata) | Center (AI rec + conversation) | Right (actions + notes + audit)

import { useState,useEffect } from 'react'
import { useParams,useNavigate } from 'react-router-dom'
import { useQuery,useMutation,useQueryClient } from '@tanstack/react-query'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card,CardContent,CardHeader,CardTitle } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { Spinner } from '@/components/ui/Spinner'
import { EmptyState } from '@/components/common/EmptyState'
import { JsonViewer } from '@/components/common/JsonViewer'
import { crmApi,computeSLAUrgency,formatMinutes } from '@/api/governance/crm.api'
import type { NoteRow,ActionRow,ActionRequest,QueueStatus } from '@/types/crm.types'
import {
PRIORITY_LABELS as PL,PRIORITY_COLORS as PC,
QUEUE_TYPE_LABELS as QTL,STATUS_LABELS as SL,STATUS_COLORS as SC,
ACTION_TYPE_LABELS as ATL,
} from '@/types/crm.types'
import { useAuthStore } from '@/stores/auth.store'
import { hasPermission } from '@/lib/access'
import { cn } from '@/lib/cn'
import {
ArrowLeft,Clock,AlertTriangle,User,Tag,Eye,Edit3,MessageSquare,Layers,UserCheck,Pin,PinOff,Plus,RefreshCw
} from 'lucide-react'

function GroupAssignSelector({ queueId }: { queueId: number }) {
  const qc = useQueryClient()
  const [groupId, setGroupId] = useState('')
  const { data: groups = [] } = useQuery({
    queryKey: ['crm-groups-active'],
    queryFn: () => crmApi.groups.list().then(r => r.data),
  })
  const assignGroup = useMutation({
    mutationFn: (gid: number) => crmApi.groups.assignTicket(queueId, gid),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['crm-queue-item', queueId] }); setGroupId('') },
  })
  if (!groups.length) return null
  return (
    <select
      className="w-full bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm text-text"
      value={groupId}
      onChange={e => {
        setGroupId(e.target.value)
        if (e.target.value) assignGroup.mutate(Number(e.target.value))
      }}
    >
      <option value="">Assign to group...</option>
      {(groups as any[]).map((g: any) => (
        <option key={g.id} value={g.id}>{g.name} ({g.routing_strategy.replace('_', ' ')})</option>
      ))}
    </select>
  )
}

function SLARow({ label, dueAt, breached }: { label: string; dueAt: string; breached: boolean }) {
  const { urgency, minutesRemaining } = computeSLAUrgency(dueAt, breached)
  const color = urgency === 'red' ? 'text-red-500' : urgency === 'amber' ? 'text-amber-500' : 'text-green-500'
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-muted">{label}</span>
      <span className={cn('font-medium flex items-center gap-1', color)}>
        <Clock className="w-3 h-3" />
        {breached ? 'Breached' : formatMinutes(minutesRemaining)}
      </span>
    </div>
  )
}

function AuditRow({ action }: { action: ActionRow }) {
  return (
    <div className="flex gap-2 text-xs py-2 border-b border-surface-border last:border-0">
      <div className="w-6 h-6 rounded-full bg-brand-600/20 flex items-center justify-center shrink-0 mt-0.5">
        <span className="text-brand-300 font-bold text-[10px]">{action.actor_name[0]}</span>
      </div>
      <div className="flex-1 min-w-0">
        <span className="font-medium text-foreground">{action.actor_name}</span>
        {' '}
        <span className="text-muted">{ATL[action.action_type] ?? action.action_type}</span>
        {action.reason && <p className="text-muted mt-0.5 italic truncate">{action.reason}</p>}
        {action.refund_amount_after != null && (
          <p className="text-green-400">₹{action.refund_amount_after.toLocaleString()}</p>
        )}
      </div>
      <span className="text-muted shrink-0">
        {new Date(action.created_at).toLocaleString('en-IN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
      </span>
    </div>
  )
}

function NoteItem({ note, canEdit, onUpdate }: {
  note: NoteRow
  canEdit: boolean
  onUpdate: (id: number, updates: { body?: string; is_pinned?: boolean }) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(note.body)

  const bgColor = {
    INTERNAL: 'bg-yellow-950/20 border-yellow-800/30',
    CUSTOMER_REPLY: 'bg-blue-950/20 border-blue-800/30',
    ESCALATION: 'bg-red-950/20 border-red-800/30',
    SYSTEM: 'bg-surface border-surface-border',
  }[note.note_type] ?? 'bg-surface border-surface-border'

  return (
    <div className={cn('rounded-md border p-3 text-sm', bgColor)}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded-full bg-brand-600/20 flex items-center justify-center">
            <span className="text-brand-300 font-bold text-[9px]">{note.author_name[0]}</span>
          </div>
          <span className="font-medium text-foreground text-xs">{note.author_name}</span>
          <Badge variant="gray" size="sm">{note.note_type.replace('_', ' ')}</Badge>
          {note.is_pinned && <Pin className="w-3 h-3 text-amber-400" />}
        </div>
        <div className="flex items-center gap-1">
          {canEdit && (
            <>
              <button
                className="text-muted hover:text-amber-400 transition-colors"
                onClick={() => onUpdate(note.id, { is_pinned: !note.is_pinned })}
              >
                {note.is_pinned ? <PinOff className="w-3 h-3" /> : <Pin className="w-3 h-3" />}
              </button>
              <button className="text-muted hover:text-foreground" onClick={() => setEditing(!editing)}>
                <Edit3 className="w-3 h-3" />
              </button>
            </>
          )}
          <span className="text-muted text-xs">
            {new Date(note.created_at).toLocaleString('en-IN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
      </div>
      {editing ? (
        <div className="flex flex-col gap-2">
          <Textarea value={draft} onChange={e => setDraft(e.target.value)} rows={3} />
          <div className="flex gap-2">
            <Button size="sm" onClick={() => { onUpdate(note.id, { body: draft }); setEditing(false) }}>Save</Button>
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <p className="text-muted text-xs whitespace-pre-wrap">{note.body}</p>
      )}
    </div>
  )
}

export default function CRMWorkViewPage() {
  const { queueId } = useParams<{ queueId: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { user } = useAuthStore()
  const canEdit = hasPermission(user, 'crm', 'edit')
  const canAdmin = hasPermission(user, 'crm', 'admin')
  const id = Number(queueId)

  // Acquire viewing lock on mount, release on unmount
  useEffect(() => {
    if (!canEdit || !id) return
    crmApi.setViewing(id, 'acquire').catch(() => {})
    return () => { crmApi.setViewing(id, 'release').catch(() => {}) }
  }, [id, canEdit])

  const { data: item, isLoading, refetch } = useQuery({
    queryKey: ['crm-ticket', id],
    queryFn: () => crmApi.getQueueItem(id).then(r => r.data),
    refetchInterval: 60_000,
    enabled: !!id,
  })

  const { data: cx360 } = useQuery({
    queryKey: ['crm-cx360', id],
    queryFn: () => crmApi.getCustomer360(id).then(r => r.data),
    enabled: !!id,
  })

  const { data: agents } = useQuery({
    queryKey: ['crm-agents'],
    queryFn: () => crmApi.getAgents().then(r => r.data),
  })

  const { data: cannedResponses } = useQuery({
    queryKey: ['crm-canned', item?.ai_action_code],
    queryFn: () => crmApi.getCannedResponses({ action_code_id: item?.ai_action_code ?? undefined }).then(r => r.data),
    enabled: !!item?.ai_action_code,
  })

  const { data: allTags } = useQuery({
    queryKey: ['crm-tags'],
    queryFn: () => crmApi.getTags().then(r => r.data),
  })

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['crm-ticket', id] })

  const actionMut = useMutation({
    mutationFn: (body: ActionRequest) => crmApi.takeAction(id, body),
    onSuccess: invalidate,
  })

  const assignMut = useMutation({
    mutationFn: (assigneeId: number) => crmApi.assignTicket(id, assigneeId),
    onSuccess: invalidate,
  })

  const selfAssignMut = useMutation({
    mutationFn: () => crmApi.selfAssign(id),
    onSuccess: invalidate,
  })

  const noteMut = useMutation({
    mutationFn: ({ body, noteType }: { body: string; noteType: string }) =>
      crmApi.addNote(id, body, noteType),
    onSuccess: invalidate,
  })

  const updateNoteMut = useMutation({
    mutationFn: ({ noteId, updates }: { noteId: number; updates: { body?: string; is_pinned?: boolean } }) =>
      crmApi.updateNote(id, noteId, updates),
    onSuccess: invalidate,
  })

  const tagsMut = useMutation({
    mutationFn: ({ add, remove }: { add: number[]; remove: number[] }) =>
      crmApi.manageTags(id, add, remove),
    onSuccess: invalidate,
  })

  const watchersMut = useMutation({
    mutationFn: ({ add, remove }: { add: number[]; remove: number[] }) =>
      crmApi.manageWatchers(id, add, remove),
    onSuccess: invalidate,
  })

  // Local action state
  const [actionType, setActionType] = useState('')
  const [modifyAmount, setModifyAmount] = useState('')
  const [modifyCode, setModifyCode] = useState('')
  const [actionReason, setActionReason] = useState('')
  const [replyBody, setReplyBody] = useState('')
  const [newPriority, setNewPriority] = useState('')
  const [newStatus, setNewStatus] = useState('')
  const [newQueue, setNewQueue] = useState('')
  const [noteBody, setNoteBody] = useState('')
  const [noteType, setNoteType] = useState('INTERNAL')
  const [assigneeId, setAssigneeId] = useState('')
  const [selectedCanned, setSelectedCanned] = useState('')

  const handleAction = () => {
    if (!actionType) return
    const body: ActionRequest = { action_type: actionType }
    if (modifyCode) body.final_action_code = modifyCode
    if (modifyAmount) body.final_refund_amount = parseFloat(modifyAmount)
    if (actionReason) body.reason = actionReason
    if (replyBody) body.reply_body = replyBody
    if (newPriority) body.new_priority = Number(newPriority)
    if (newStatus) body.new_status = newStatus as QueueStatus
    if (newQueue) body.new_queue_type = newQueue as any
    actionMut.mutate(body, {
      onSuccess: () => {
        setActionType(''); setModifyAmount(''); setModifyCode(''); setActionReason('')
        setReplyBody(''); setNewPriority(''); setNewStatus(''); setNewQueue('')
      },
    })
  }

  const handleNote = () => {
    if (!noteBody.trim()) return
    noteMut.mutate({ body: noteBody, noteType }, { onSuccess: () => setNoteBody('') })
  }

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner size="lg" />
      </div>
    )
  }

  if (!item) {
    return (
      <div className="p-6">
        <EmptyState title="Ticket not found" description="This ticket does not exist or you don't have access." />
      </div>
    )
  }

  const { urgency } = computeSLAUrgency(item.sla_due_at, item.sla_breached)
  const notes: NoteRow[] = item.notes ?? []
  const actions: ActionRow[] = item.actions ?? []

  return (
    <div className="p-4 max-w-full">
      <PageHeader
        title={item.subject || `Ticket #${item.ticket_id}`}
        subtitle={`#${item.ticket_id} · ${QTL[item.queue_type] ?? item.queue_type}`}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => navigate('/crm')}>
              <ArrowLeft className="w-4 h-4 mr-1" /> Queue
            </Button>
            <Button variant="ghost" size="sm" onClick={() => refetch()}>
              <RefreshCw className="w-4 h-4" />
            </Button>
          </div>
        }
      />

      {/* Viewing collision warning */}
      {item.viewing_agent_name && item.viewing_agent_name !== user?.full_name && (
        <div className="mb-4 flex items-center gap-2 bg-amber-950/30 border border-amber-700/40 rounded-md px-4 py-2 text-amber-400 text-sm">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <strong>{item.viewing_agent_name}</strong> is currently viewing this ticket. Edits may conflict.
        </div>
      )}

      {/* Status bar */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <span className={cn('text-xs px-2.5 py-1 rounded-full font-medium', SC[item.status])}>
          {SL[item.status]}
        </span>
        <span className={cn('text-xs px-2 py-0.5 rounded font-medium', PC[item.priority])}>
          {PL[item.priority]}
        </span>
        <Badge variant="blue" size="sm">{QTL[item.queue_type]}</Badge>
        <span className={cn(
          'text-xs flex items-center gap-1 px-2 py-0.5 rounded border',
          urgency === 'red' ? 'bg-red-950/30 border-red-700/40 text-red-400' :
          urgency === 'amber' ? 'bg-amber-950/30 border-amber-700/40 text-amber-400' :
          'bg-green-950/30 border-green-700/40 text-green-400'
        )}>
          <Clock className="w-3 h-3" />
          SLA: {formatMinutes(computeSLAUrgency(item.sla_due_at, item.sla_breached).minutesRemaining)}
        </span>
        {item.assigned_to_name ? (
          <span className="text-xs text-muted flex items-center gap-1">
            <UserCheck className="w-3 h-3" /> {item.assigned_to_name}
          </span>
        ) : (
          <span className="text-xs text-muted">Unassigned</span>
        )}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[280px_1fr_320px] gap-4">

        {/* ── LEFT PANEL ─────────────────────────────────── */}
        <div className="flex flex-col gap-4">

          {/* Ticket Metadata */}
          <Card>
            <CardHeader><CardTitle className="text-sm">Ticket Details</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-xs">
              <div className="flex justify-between"><span className="text-muted">Ticket ID</span><span>#{item.ticket_id}</span></div>
              <div className="flex justify-between"><span className="text-muted">Order ID</span><span>{item.order_id ?? '—'}</span></div>
              <div className="flex justify-between"><span className="text-muted">Customer</span><span className="truncate max-w-[120px]">{item.cx_email ?? '—'}</span></div>
              <div className="flex justify-between"><span className="text-muted">Segment</span><span>{item.customer_segment ?? '—'}</span></div>
              <div className="flex justify-between"><span className="text-muted">Type</span><span>{item.ticket_type}</span></div>
              <div className="flex justify-between"><span className="text-muted">Pathway</span><Badge variant="amber" size="sm">{item.automation_pathway}</Badge></div>
              <div className="flex justify-between"><span className="text-muted">Created</span><span>{new Date(item.created_at).toLocaleDateString('en-IN')}</span></div>
              {item.resolved_at && <div className="flex justify-between"><span className="text-muted">Resolved</span><span>{new Date(item.resolved_at).toLocaleDateString('en-IN')}</span></div>}
              <div className="pt-1 border-t border-surface-border">
                <SLARow label="Resolution SLA" dueAt={item.sla_due_at} breached={item.sla_breached} />
                <SLARow label="First Response SLA" dueAt={item.first_response_due_at} breached={item.first_response_breached} />
              </div>
            </CardContent>
          </Card>

          {/* Customer 360 */}
          {cx360 && (
            <Card>
              <CardHeader><CardTitle className="text-sm flex items-center gap-1"><User className="w-3.5 h-3.5" /> Customer 360°</CardTitle></CardHeader>
              <CardContent className="text-xs space-y-2">
                <div className="flex justify-between"><span className="text-muted">Customer ID</span><span className="font-mono">{cx360.customer_id}</span></div>
                <div className="flex justify-between"><span className="text-muted">Segment</span><Badge variant="purple" size="sm">{cx360.segment}</Badge></div>
                <div className="flex justify-between"><span className="text-muted">Total Orders</span><span>{cx360.lifetime_order_count}</span></div>
                <div className="flex justify-between"><span className="text-muted">CSAT</span><span>{cx360.csat_average != null ? `${cx360.csat_average.toFixed(1)}/5` : '—'}</span></div>
                {cx360.recent_tickets.length > 0 && (
                  <div className="pt-1 border-t border-surface-border">
                    <p className="text-muted font-medium mb-1">Recent Tickets</p>
                    {cx360.recent_tickets.slice(0, 3).map(t => (
                      <div key={t.ticket_id} className="flex justify-between py-0.5">
                        <span className="text-brand-400 cursor-pointer hover:underline" onClick={() => t.queue_id && navigate(`/crm/ticket/${t.queue_id}`)}>
                          #{t.ticket_id}
                        </span>
                        <span className="text-muted truncate max-w-[120px]">{t.subject ?? '—'}</span>
                      </div>
                    ))}
                  </div>
                )}
                {cx360.recent_refunds.length > 0 && (
                  <div className="pt-1 border-t border-surface-border">
                    <p className="text-muted font-medium mb-1">Recent Refunds</p>
                    {cx360.recent_refunds.slice(0, 3).map((r, i) => (
                      <div key={i} className="flex justify-between py-0.5">
                        <span className="text-green-400">₹{r.refund_amount.toLocaleString()}</span>
                        <span className="text-muted font-mono text-[10px]">{r.applied_action_code ?? '—'}</span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Tags */}
          <Card>
            <CardHeader><CardTitle className="text-sm flex items-center gap-1"><Tag className="w-3.5 h-3.5" /> Tags</CardTitle></CardHeader>
            <CardContent>
              <div className="flex gap-1.5 flex-wrap mb-2">
                {item.tags.map(tag => (
                  <span
                    key={tag.id}
                    className="text-xs px-2 py-0.5 rounded cursor-pointer flex items-center gap-1"
                    style={{ backgroundColor: tag.color + '22', color: tag.color, border: `1px solid ${tag.color}44` }}
                    onClick={() => canEdit && tagsMut.mutate({ add: [], remove: [tag.id] })}
                  >
                    {tag.name} {canEdit && '×'}
                  </span>
                ))}
              </div>
              {canEdit && allTags && (
                <Select
                  options={[
                    { value: '', label: 'Add tag…' },
                    ...(allTags ?? [])
                      .filter(t => !item.tags.find(it => it.id === t.id))
                      .map(t => ({ value: String(t.id), label: t.name })),
                  ]}
                  value=""
                  onChange={e => e.target.value && tagsMut.mutate({ add: [Number(e.target.value)], remove: [] })}
                />
              )}
            </CardContent>
          </Card>

          {/* Watchers */}
          <Card>
            <CardHeader><CardTitle className="text-sm flex items-center gap-1"><Eye className="w-3.5 h-3.5" /> Watchers</CardTitle></CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {item.watchers?.map(w => (
                  <div key={w.user_id} className="flex items-center gap-1 bg-surface rounded px-2 py-0.5 text-xs">
                    <span>{w.full_name}</span>
                    {canEdit && (
                      <button className="text-muted hover:text-red-400" onClick={() => watchersMut.mutate({ add: [], remove: [w.user_id] })}>×</button>
                    )}
                  </div>
                ))}
              </div>
              {canEdit && agents && (
                <Select
                  options={[
                    { value: '', label: 'Add watcher…' },
                    ...(agents ?? [])
                      .filter(a => !item.watchers?.find(w => w.user_id === a.id))
                      .map(a => ({ value: String(a.id), label: a.full_name })),
                  ]}
                  value=""
                  onChange={e => e.target.value && watchersMut.mutate({ add: [Number(e.target.value)], remove: [] })}
                />
              )}
            </CardContent>
          </Card>
        </div>

        {/* ── CENTER PANEL ─────────────────────────────── */}
        <div className="flex flex-col gap-4">

          {/* AI Recommendation */}
          <Card className={cn(
            'border-2',
            item.final_action_code ? 'border-green-700/40' : 'border-amber-700/40'
          )}>
            <CardHeader>
              <CardTitle className="text-sm flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <Layers className="w-4 h-4 text-brand-400" />
                  AI Recommendation
                </span>
                {item.final_action_code && (
                  <Badge variant="green" size="sm">Decision Made</Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-xs text-muted mb-1">Suggested Action Code</p>
                  <p className="font-mono font-bold text-brand-300">{item.ai_action_code ?? '—'}</p>
                </div>
                <div>
                  <p className="text-xs text-muted mb-1">Suggested Refund</p>
                  <p className="font-bold text-green-400">
                    {item.ai_refund_amount != null ? `₹${item.ai_refund_amount.toLocaleString()}` : '—'}
                  </p>
                </div>
                {item.final_action_code && (
                  <>
                    <div>
                      <p className="text-xs text-muted mb-1">Final Action Code</p>
                      <p className="font-mono font-bold text-green-300">{item.final_action_code}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted mb-1">Final Refund</p>
                      <p className="font-bold text-green-400">
                        {item.final_refund_amount != null ? `₹${item.final_refund_amount.toLocaleString()}` : '—'}
                      </p>
                    </div>
                  </>
                )}
              </div>
              {item.ai_reasoning && (
                <div>
                  <p className="text-xs text-muted mb-1">AI Reasoning</p>
                  <p className="text-xs text-muted bg-surface/60 rounded p-2 border border-surface-border">{item.ai_reasoning}</p>
                </div>
              )}
              {item.ai_discrepancy_details && (
                <div className="flex items-start gap-2 bg-amber-950/20 border border-amber-700/30 rounded p-2">
                  <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                  <p className="text-xs text-amber-300">{item.ai_discrepancy_details}</p>
                </div>
              )}
              {item.ai_confidence != null && (
                <div>
                  <p className="text-xs text-muted mb-1">AI Confidence</p>
                  <div className="flex items-center gap-2">
                    <div className="h-2 flex-1 rounded-full bg-surface overflow-hidden">
                      <div
                        className={cn('h-2 rounded-full', item.ai_confidence >= 0.8 ? 'bg-green-500' : item.ai_confidence >= 0.6 ? 'bg-amber-500' : 'bg-red-500')}
                        style={{ width: `${(item.ai_confidence * 100).toFixed(0)}%` }}
                      />
                    </div>
                    <span className="text-xs font-bold">{(item.ai_confidence * 100).toFixed(0)}%</span>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Raw Ticket */}
          {item.ticket && (
            <Card>
              <CardHeader><CardTitle className="text-sm">Raw Ticket</CardTitle></CardHeader>
              <CardContent>
                <JsonViewer data={item.ticket} maxHeight={200} />
              </CardContent>
            </Card>
          )}

          {/* LLM Outputs */}
          {item.llm_output_3 && (
            <Card>
              <CardHeader><CardTitle className="text-sm">Pipeline Output (llm_output_3)</CardTitle></CardHeader>
              <CardContent>
                <JsonViewer data={item.llm_output_3} maxHeight={200} />
              </CardContent>
            </Card>
          )}

          {/* Notes & Replies thread */}
          <Card>
            <CardHeader><CardTitle className="text-sm flex items-center gap-2"><MessageSquare className="w-4 h-4" /> Notes & Replies</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {notes.length === 0 && (
                <p className="text-xs text-muted text-center py-4">No notes yet.</p>
              )}
              {notes
                .sort((a, b) => (b.is_pinned ? 1 : 0) - (a.is_pinned ? 1 : 0) || new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
                .map(note => (
                  <NoteItem
                    key={note.id}
                    note={note}
                    canEdit={canEdit}
                    onUpdate={(noteId, updates) => updateNoteMut.mutate({ noteId, updates })}
                  />
                ))
              }

              {canEdit && (
                <div className="border-t border-surface-border pt-3 flex flex-col gap-2">
                  <div className="flex gap-2">
                    <Select
                      options={[
                        { value: 'INTERNAL', label: 'Internal Note' },
                        { value: 'CUSTOMER_REPLY', label: 'Reply to Customer' },
                        { value: 'ESCALATION', label: 'Escalation Note' },
                      ]}
                      value={noteType}
                      onChange={e => setNoteType(e.target.value)}
                    />
                    {noteType === 'CUSTOMER_REPLY' && cannedResponses && cannedResponses.length > 0 && (
                      <Select
                        options={[
                          { value: '', label: 'Canned response…' },
                          ...cannedResponses.map(r => ({ value: r.template_v1 ?? '', label: r.template_ref })),
                        ]}
                        value={selectedCanned}
                        onChange={e => { setSelectedCanned(e.target.value); if (e.target.value) setNoteBody(e.target.value) }}
                      />
                    )}
                  </div>
                  <Textarea
                    placeholder={noteType === 'CUSTOMER_REPLY' ? 'Write reply to customer…' : 'Add internal note…'}
                    value={noteBody}
                    onChange={e => setNoteBody(e.target.value)}
                    rows={3}
                  />
                  <Button size="sm" onClick={handleNote} disabled={!noteBody.trim() || noteMut.isPending}>
                    {noteMut.isPending ? <Spinner size="sm" /> : <><Plus className="w-3.5 h-3.5 mr-1" /> Add Note</>}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* ── RIGHT PANEL ──────────────────────────────── */}
        <div className="flex flex-col gap-4">

          {/* Assignment */}
          {canEdit && (
            <Card>
              <CardHeader><CardTitle className="text-sm flex items-center gap-2"><UserCheck className="w-4 h-4" /> Assignment</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {agents && (
                  <Select
                    options={[
                      { value: '', label: 'Unassigned' },
                      ...(agents ?? []).map(a => ({ value: String(a.id), label: `${a.full_name} (${a.open_tickets} open)` })),
                    ]}
                    value={assigneeId || (item.assigned_to ? String(item.assigned_to) : '')}
                    onChange={e => {
                      setAssigneeId(e.target.value)
                      if (e.target.value) assignMut.mutate(Number(e.target.value))
                    }}
                  />
                )}
                <GroupAssignSelector queueId={id} />
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full"
                  onClick={() => selfAssignMut.mutate()}
                  disabled={selfAssignMut.isPending}
                >
                  Self-Assign
                </Button>
              </CardContent>
            </Card>
          )}

          {/* Actions */}
          {canEdit && (
            <Card>
              <CardHeader><CardTitle className="text-sm">Take Action</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <Select
                  options={[
                    { value: '', label: 'Select action…' },
                    { value: 'APPROVE_AI_REC', label: 'Approve AI Recommendation' },
                    { value: 'REJECT_AI_REC', label: 'Reject AI Recommendation' },
                    { value: 'MODIFY_REFUND', label: 'Modify Refund Amount' },
                    { value: 'REPLY_CUSTOMER', label: 'Reply to Customer' },
                    { value: 'ESCALATE', label: 'Escalate' },
                    { value: 'CHANGE_PRIORITY', label: 'Change Priority' },
                    { value: 'CHANGE_STATUS', label: 'Change Status' },
                    { value: 'CHANGE_QUEUE', label: 'Change Queue' },
                    { value: 'RESOLVE', label: 'Resolve Ticket' },
                    { value: 'REOPEN', label: 'Reopen Ticket' },
                    { value: 'CLOSE', label: 'Close Ticket' },
                  ]}
                  value={actionType}
                  onChange={e => { setActionType(e.target.value); setActionReason(''); setModifyAmount(''); setModifyCode('') }}
                />

                {actionType === 'MODIFY_REFUND' && (
                  <>
                    <Input
                      placeholder="Final action code"
                      value={modifyCode}
                      onChange={e => setModifyCode(e.target.value)}
                      className="h-8 text-sm font-mono"
                    />
                    <Input
                      placeholder="Final refund amount (₹)"
                      value={modifyAmount}
                      onChange={e => setModifyAmount(e.target.value)}
                      type="number"
                      className="h-8 text-sm"
                    />
                  </>
                )}

                {actionType === 'REPLY_CUSTOMER' && (
                  <Textarea
                    placeholder="Reply body…"
                    value={replyBody}
                    onChange={e => setReplyBody(e.target.value)}
                    rows={3}
                  />
                )}

                {actionType === 'CHANGE_PRIORITY' && (
                  <Select
                    options={[
                      { value: '1', label: '1 — Critical' },
                      { value: '2', label: '2 — High' },
                      { value: '3', label: '3 — Normal' },
                      { value: '4', label: '4 — Low' },
                    ]}
                    value={newPriority}
                    onChange={e => setNewPriority(e.target.value)}
                  />
                )}

                {actionType === 'CHANGE_STATUS' && (
                  <Select
                    options={[
                      { value: 'OPEN', label: 'Open' },
                      { value: 'IN_PROGRESS', label: 'In Progress' },
                      { value: 'PENDING_CUSTOMER', label: 'Pending Customer' },
                    ]}
                    value={newStatus}
                    onChange={e => setNewStatus(e.target.value)}
                  />
                )}

                {actionType === 'CHANGE_QUEUE' && (
                  <Select
                    options={[
                      { value: 'STANDARD_REVIEW', label: 'Standard Review' },
                      { value: 'SENIOR_REVIEW', label: 'Senior Review' },
                      { value: 'SLA_BREACH_REVIEW', label: 'SLA Breach' },
                      { value: 'ESCALATION_QUEUE', label: 'Escalation Queue' },
                      { value: 'MANUAL_REVIEW', label: 'Manual Review' },
                    ]}
                    value={newQueue}
                    onChange={e => setNewQueue(e.target.value)}
                  />
                )}

                {['ESCALATE', 'REJECT_AI_REC', 'RESOLVE', 'CLOSE'].includes(actionType) && (
                  <Textarea
                    placeholder="Reason / resolution note…"
                    value={actionReason}
                    onChange={e => setActionReason(e.target.value)}
                    rows={2}
                  />
                )}

                {actionType && (
                  <Button
                    className="w-full"
                    size="sm"
                    onClick={handleAction}
                    disabled={actionMut.isPending}
                    variant={['RESOLVE', 'APPROVE_AI_REC'].includes(actionType) ? 'primary' : 'primary'}
                  >
                    {actionMut.isPending ? <Spinner size="sm" /> : ATL[actionType] ?? actionType}
                  </Button>
                )}

                {actionMut.isError && (
                  <p className="text-xs text-red-400">Action failed. Please try again.</p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Audit Timeline */}
          <Card>
            <CardHeader><CardTitle className="text-sm flex items-center gap-2"><Clock className="w-4 h-4" /> Audit Timeline</CardTitle></CardHeader>
            <CardContent>
              {actions.length === 0 ? (
                <p className="text-xs text-muted text-center py-4">No actions yet.</p>
              ) : (
                <div className="max-h-80 overflow-y-auto">
                  {actions
                    .slice()
                    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
                    .map(action => <AuditRow key={action.id} action={action} />)
                  }
                </div>
              )}
            </CardContent>
          </Card>

          {/* Merge (admin only) */}
          {canAdmin && !item.merged_into && !['RESOLVED', 'CLOSED'].includes(item.status) && (
            <MergePanel queueId={id} onSuccess={invalidate} />
          )}
        </div>
      </div>
    </div>
  )
}

function MergePanel({ queueId, onSuccess }: { queueId: number; onSuccess: () => void }) {
  const [targetId, setTargetId] = useState('')
  const [reason, setReason] = useState('')
  const mut = useMutation({
    mutationFn: () => crmApi.mergeTickets(queueId, Number(targetId), reason),
    onSuccess,
  })

  return (
    <Card>
      <CardHeader><CardTitle className="text-sm flex items-center gap-2"><Layers className="w-4 h-4" /> Merge Into</CardTitle></CardHeader>
      <CardContent className="space-y-2">
        <Input
          placeholder="Target queue ID…"
          value={targetId}
          onChange={e => setTargetId(e.target.value)}
          type="number"
          className="h-8 text-sm"
        />
        <Input
          placeholder="Reason (optional)"
          value={reason}
          onChange={e => setReason(e.target.value)}
          className="h-8 text-sm"
        />
        <Button
          size="sm"
          className="w-full"
          onClick={() => mut.mutate()}
          disabled={!targetId || mut.isPending}
          variant="primary"
        >
          {mut.isPending ? <Spinner size="sm" /> : 'Merge Ticket'}
        </Button>
      </CardContent>
    </Card>
  )
}
