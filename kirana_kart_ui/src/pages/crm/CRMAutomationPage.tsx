import { useState, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Plus, Pencil, Copy, Trash2, X, Zap, Search,
  ChevronUp, ChevronDown, PlayCircle,
  ToggleLeft, ToggleRight, AlertTriangle,
  Clock, Ticket, Edit3, Bell, CheckSquare, Square,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { Badge } from '@/components/ui/Badge'
import { Card, CardContent } from '@/components/ui/Card'
import { Spinner } from '@/components/ui/Spinner'
import { Switch } from '@/components/ui/Switch'
import { crmApi } from '@/api/governance/crm.api'
import { toast } from '@/stores/toast.store'
import { cn } from '@/lib/cn'
import type { AutomationRule, RuleCondition, RuleAction, AgentSummary, Group } from '@/types/crm.types'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

type TriggerEvent = 'TICKET_CREATED' | 'TICKET_UPDATED' | 'SLA_WARNING' | 'SLA_BREACHED' | 'TIME_BASED'
type FilterTab = 'all' | 'event' | 'time' | 'disabled'
type SortColumn = 'priority' | 'name' | 'run_count' | 'last_run_at'
type SortDir = 'asc' | 'desc'

interface TriggerMeta {
  label: string
  icon: React.ReactNode
  badgeVariant: 'green' | 'blue' | 'amber' | 'red' | 'purple'
  description: string
}

const TRIGGER_META: Record<TriggerEvent, TriggerMeta> = {
  TICKET_CREATED: {
    label: 'Ticket Created',
    icon: <Ticket className="w-4 h-4" />,
    badgeVariant: 'green',
    description: 'When a new ticket enters the queue',
  },
  TICKET_UPDATED: {
    label: 'Ticket Updated',
    icon: <Edit3 className="w-4 h-4" />,
    badgeVariant: 'blue',
    description: 'When any field on a ticket changes',
  },
  SLA_WARNING: {
    label: 'SLA Warning',
    icon: <Bell className="w-4 h-4" />,
    badgeVariant: 'amber',
    description: '15 minutes before SLA deadline',
  },
  SLA_BREACHED: {
    label: 'SLA Breached',
    icon: <AlertTriangle className="w-4 h-4" />,
    badgeVariant: 'red',
    description: 'When SLA deadline is exceeded',
  },
  TIME_BASED: {
    label: 'Time-Based',
    icon: <Clock className="w-4 h-4" />,
    badgeVariant: 'purple',
    description: 'X hours/minutes after a condition',
  },
}

const CONDITION_FIELDS = [
  { value: 'queue_type',          label: 'Queue Type' },
  { value: 'status',              label: 'Status' },
  { value: 'priority',            label: 'Priority' },
  { value: 'customer_segment',    label: 'Customer Segment' },
  { value: 'ai_action_code',      label: 'AI Action Code' },
  { value: 'ai_confidence',       label: 'AI Confidence' },
  { value: 'ai_fraud_segment',    label: 'AI Fraud Segment' },
  { value: 'ai_refund_amount',    label: 'AI Refund Amount' },
  { value: 'automation_pathway',  label: 'Automation Pathway' },
  { value: 'hours_since_created', label: 'Hours Since Created' },
  { value: 'hours_since_updated', label: 'Hours Since Updated' },
]

const ENUM_VALUES: Record<string, string[]> = {
  queue_type: ['STANDARD_REVIEW', 'SENIOR_REVIEW', 'SLA_BREACH_REVIEW', 'ESCALATION_QUEUE', 'MANUAL_REVIEW'],
  status: ['OPEN', 'IN_PROGRESS', 'PENDING_CUSTOMER', 'ESCALATED', 'RESOLVED', 'CLOSED'],
  priority: ['1', '2', '3', '4'],
  ai_fraud_segment: ['LOW', 'MEDIUM', 'HIGH', 'VERY_HIGH'],
  automation_pathway: ['HITL', 'MANUAL_REVIEW'],
}

const PRIORITY_LABEL: Record<string, string> = {
  '1': '1 - Critical',
  '2': '2 - High',
  '3': '3 - Normal',
  '4': '4 - Low',
}

const NUMERIC_FIELDS = new Set(['ai_confidence', 'ai_refund_amount', 'hours_since_created', 'hours_since_updated'])

const STRING_OPERATORS = [
  { value: 'is',         label: 'is' },
  { value: 'is_not',     label: 'is not' },
  { value: 'contains',   label: 'contains' },
  { value: 'is_one_of',  label: 'is one of' },
]

const NUMERIC_OPERATORS = [
  { value: 'is',                     label: 'is' },
  { value: 'is_not',                 label: 'is not' },
  { value: 'greater_than',           label: 'greater than' },
  { value: 'less_than',              label: 'less than' },
  { value: 'greater_than_or_equal',  label: 'greater than or equal' },
  { value: 'less_than_or_equal',     label: 'less than or equal' },
]

const ACTION_TYPES = [
  { value: 'assign_to_group',   label: 'Assign to Group' },
  { value: 'assign_to_agent',   label: 'Assign to Agent' },
  { value: 'change_priority',   label: 'Change Priority' },
  { value: 'change_queue_type', label: 'Change Queue Type' },
  { value: 'change_status',     label: 'Change Status' },
  { value: 'add_tag',           label: 'Add Tag' },
  { value: 'send_notification', label: 'Send Notification' },
  { value: 'escalate',          label: 'Escalate' },
]

const QUEUE_TYPE_OPTIONS = ENUM_VALUES.queue_type.map(v => ({ value: v, label: v.replace(/_/g, ' ') }))
const STATUS_OPTIONS      = ENUM_VALUES.status.map(v => ({ value: v, label: v.replace(/_/g, ' ') }))
const PRIORITY_OPTIONS    = ['1', '2', '3', '4'].map(v => ({ value: v, label: PRIORITY_LABEL[v] }))

const FILTER_TABS: { key: FilterTab; label: string }[] = [
  { key: 'all',      label: 'All' },
  { key: 'event',    label: 'Event-Based Triggers' },
  { key: 'time',     label: 'Time-Based' },
  { key: 'disabled', label: 'Disabled' },
]

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RuleFormState {
  name: string
  description: string
  priority: number
  is_active: boolean
  trigger_event: TriggerEvent
  time_based_amount: number
  time_based_unit: 'hours' | 'minutes'
  time_based_after: 'created' | 'updated' | 'first_response_due'
  condition_logic: 'AND' | 'OR'
  conditions: RuleCondition[]
  actions: RuleAction[]
}

interface PreviewTicket {
  id: number
  subject: string | null
  queue_type: string
  status: string
  priority: number
  created_at: string
}

interface PreviewResult {
  count: number
  tickets: PreviewTicket[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function conditionsSummary(conditions: RuleCondition[], logic: string): string {
  if (!conditions.length) return 'No conditions'
  return `${conditions.length} condition${conditions.length !== 1 ? 's' : ''} (${logic})`
}

function actionsSummary(actions: RuleAction[]): string {
  if (!actions.length) return 'No actions'
  return `${actions.length} action${actions.length !== 1 ? 's' : ''}`
}

function blankForm(): RuleFormState {
  return {
    name: '',
    description: '',
    priority: 100,
    is_active: true,
    trigger_event: 'TICKET_CREATED',
    time_based_amount: 2,
    time_based_unit: 'hours',
    time_based_after: 'created',
    condition_logic: 'AND',
    conditions: [],
    actions: [],
  }
}

function ruleToForm(rule: AutomationRule): RuleFormState {
  return {
    name: rule.name,
    description: rule.description ?? '',
    priority: rule.priority,
    is_active: rule.is_active,
    trigger_event: rule.trigger_event as TriggerEvent,
    time_based_amount: 2,
    time_based_unit: 'hours',
    time_based_after: 'created',
    condition_logic: rule.condition_logic,
    conditions: rule.conditions.map(c => ({ ...c })),
    actions: rule.actions.map(a => ({ ...a, params: { ...a.params } })),
  }
}

// ---------------------------------------------------------------------------
// StatCard
// ---------------------------------------------------------------------------

function StatCard({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <Card className="flex-1 min-w-[140px]">
      <CardContent className="py-4">
        <p className="text-xs text-muted mb-1">{label}</p>
        <p className="text-2xl font-bold text-foreground tabular-nums">{value}</p>
        {sub && <p className="text-xs text-subtle mt-0.5">{sub}</p>}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// TriggerBadge
// ---------------------------------------------------------------------------

function TriggerBadge({ event }: { event: string }) {
  const meta = TRIGGER_META[event as TriggerEvent]
  if (!meta) return <Badge variant="gray">{event}</Badge>
  return (
    <Badge variant={meta.badgeVariant} className="flex items-center gap-1 whitespace-nowrap">
      {meta.icon}
      {meta.label}
    </Badge>
  )
}

// ---------------------------------------------------------------------------
// ConditionRow
// ---------------------------------------------------------------------------

interface ConditionRowProps {
  condition: RuleCondition
  index: number
  onChange: (updated: RuleCondition) => void
  onRemove: () => void
}

function ConditionRow({ condition, index, onChange, onRemove }: ConditionRowProps) {
  const isNumeric = NUMERIC_FIELDS.has(condition.field)
  const isEnum    = Object.prototype.hasOwnProperty.call(ENUM_VALUES, condition.field)
  const operators = isNumeric ? NUMERIC_OPERATORS : STRING_OPERATORS
  const enumVals  = isEnum ? ENUM_VALUES[condition.field] : []

  const handleFieldChange = (field: string) => {
    onChange({ field, operator: 'is', value: '' })
  }

  return (
    <div className="flex items-start gap-2">
      <span className="mt-2 text-xs text-subtle w-5 text-right shrink-0">{index + 1}.</span>
      <div className="flex-1 grid grid-cols-3 gap-2">
        <Select
          options={CONDITION_FIELDS}
          placeholder="Select field…"
          value={condition.field}
          onChange={e => handleFieldChange(e.target.value)}
        />
        <Select
          options={operators}
          placeholder="Operator…"
          value={condition.operator}
          onChange={e => onChange({ ...condition, operator: e.target.value })}
        />
        {isEnum ? (
          <Select
            options={enumVals.map(v => ({
              value: v,
              label: condition.field === 'priority' ? (PRIORITY_LABEL[v] ?? v) : v.replace(/_/g, ' '),
            }))}
            placeholder="Select value…"
            value={condition.value}
            onChange={e => onChange({ ...condition, value: e.target.value })}
          />
        ) : (
          <Input
            type={isNumeric ? 'number' : 'text'}
            placeholder={isNumeric ? '0' : 'Value…'}
            value={condition.value}
            onChange={e => onChange({ ...condition, value: e.target.value })}
          />
        )}
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="mt-2 p-1 text-subtle hover:text-red-400 transition-colors shrink-0"
        aria-label="Remove condition"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ActionRow
// ---------------------------------------------------------------------------

interface ActionRowProps {
  action: RuleAction
  index: number
  groups: Group[]
  agents: AgentSummary[]
  onChange: (updated: RuleAction) => void
  onRemove: () => void
}

function ActionRow({ action, index, groups, agents, onChange, onRemove }: ActionRowProps) {
  const handleTypeChange = (type: string) => {
    onChange({ action_type: type, params: {} })
  }

  const renderParams = () => {
    switch (action.action_type) {
      case 'assign_to_group':
        return (
          <Select
            options={groups.map(g => ({ value: String(g.id), label: g.name }))}
            placeholder="Select group…"
            value={String(action.params.group_id ?? '')}
            onChange={e => onChange({ ...action, params: { ...action.params, group_id: Number(e.target.value) } })}
          />
        )
      case 'assign_to_agent':
        return (
          <Select
            options={agents.map(a => ({ value: String(a.id), label: a.full_name }))}
            placeholder="Select agent…"
            value={String(action.params.agent_id ?? '')}
            onChange={e => onChange({ ...action, params: { ...action.params, agent_id: Number(e.target.value) } })}
          />
        )
      case 'change_priority':
        return (
          <Select
            options={PRIORITY_OPTIONS}
            placeholder="Select priority…"
            value={String(action.params.priority ?? '')}
            onChange={e => onChange({ ...action, params: { ...action.params, priority: Number(e.target.value) } })}
          />
        )
      case 'change_queue_type':
        return (
          <Select
            options={QUEUE_TYPE_OPTIONS}
            placeholder="Select queue type…"
            value={String(action.params.queue_type ?? '')}
            onChange={e => onChange({ ...action, params: { ...action.params, queue_type: e.target.value } })}
          />
        )
      case 'change_status':
        return (
          <Select
            options={STATUS_OPTIONS}
            placeholder="Select status…"
            value={String(action.params.status ?? '')}
            onChange={e => onChange({ ...action, params: { ...action.params, status: e.target.value } })}
          />
        )
      case 'add_tag':
        return (
          <Input
            placeholder="Tag name…"
            value={String(action.params.tag_name ?? '')}
            onChange={e => onChange({ ...action, params: { ...action.params, tag_name: e.target.value } })}
          />
        )
      case 'send_notification':
        return (
          <Input
            placeholder="Notification message…"
            value={String(action.params.message ?? '')}
            onChange={e => onChange({ ...action, params: { ...action.params, message: e.target.value } })}
          />
        )
      case 'escalate':
        return <span className="flex items-center h-full text-xs text-subtle py-2 px-1">No additional params required.</span>
      default:
        return null
    }
  }

  return (
    <div className="flex items-start gap-2">
      <span className="mt-2 text-xs text-subtle w-5 text-right shrink-0">{index + 1}.</span>
      <div className="flex-1 grid grid-cols-2 gap-2">
        <Select
          options={ACTION_TYPES}
          placeholder="Select action…"
          value={action.action_type}
          onChange={e => handleTypeChange(e.target.value)}
        />
        <div>{renderParams()}</div>
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="mt-2 p-1 text-subtle hover:text-red-400 transition-colors shrink-0"
        aria-label="Remove action"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// SortHeader helper
// ---------------------------------------------------------------------------

function SortHeader({
  col,
  label,
  sortCol,
  sortDir,
  onSort,
  className,
}: {
  col: SortColumn
  label: string
  sortCol: SortColumn
  sortDir: SortDir
  onSort: (c: SortColumn) => void
  className?: string
}) {
  const active = sortCol === col
  return (
    <th
      className={cn('px-3 py-3 cursor-pointer select-none', className)}
      onClick={() => onSort(col)}
    >
      <span className="flex items-center gap-1 text-xs font-medium text-subtle">
        {label}
        {active
          ? sortDir === 'asc'
            ? <ChevronUp className="w-3.5 h-3.5 text-brand-400" />
            : <ChevronDown className="w-3.5 h-3.5 text-brand-400" />
          : <ChevronUp className="w-3.5 h-3.5 opacity-20" />}
      </span>
    </th>
  )
}

// ---------------------------------------------------------------------------
// Rule Editor Drawer
// ---------------------------------------------------------------------------

interface RuleEditorProps {
  editingRule: AutomationRule | null
  prefillForm: RuleFormState | null   // for clone
  groups: Group[]
  agents: AgentSummary[]
  onClose: () => void
  onSaved: () => void
}

function RuleEditor({ editingRule, prefillForm, groups, agents, onClose, onSaved }: RuleEditorProps) {
  const qc = useQueryClient()

  const initialForm: RuleFormState = prefillForm
    ? prefillForm
    : editingRule
      ? ruleToForm(editingRule)
      : blankForm()

  const [form, setForm] = useState<RuleFormState>(initialForm)
  const [previewState, setPreviewState] = useState<'idle' | 'loading' | 'done'>('idle')
  const [previewResult, setPreviewResult] = useState<PreviewResult | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const isEdit = editingRule !== null && prefillForm === null

  // ── Mutations ──
  const createMutation = useMutation({
    mutationFn: (body: Parameters<typeof crmApi.automationRules.create>[0]) =>
      crmApi.automationRules.create(body).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['crm-automation-rules'] })
      toast.success('Rule created', `"${form.name}" is now active.`)
      onSaved()
    },
    onError: (err: unknown) => {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      toast.error('Create failed', detail ?? 'Failed to create rule.')
    },
  })

  const updateMutation = useMutation({
    mutationFn: (body: Parameters<typeof crmApi.automationRules.update>[1]) =>
      crmApi.automationRules.update(editingRule!.id, body).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['crm-automation-rules'] })
      toast.success('Rule updated', `"${form.name}" has been saved.`)
      onSaved()
    },
    onError: (err: unknown) => {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      toast.error('Update failed', detail ?? 'Failed to update rule.')
    },
  })

  const isSaving = createMutation.isPending || updateMutation.isPending

  // ── Form helpers ──
  const setField = useCallback(<K extends keyof RuleFormState>(key: K, val: RuleFormState[K]) => {
    setForm(prev => ({ ...prev, [key]: val }))
    setErrors(prev => { const next = { ...prev }; delete next[key]; return next })
  }, [])

  const addCondition = () =>
    setField('conditions', [...form.conditions, { field: 'status', operator: 'is', value: '' }])

  const updateCondition = (i: number, updated: RuleCondition) => {
    const next = [...form.conditions]; next[i] = updated; setField('conditions', next)
  }
  const removeCondition = (i: number) =>
    setField('conditions', form.conditions.filter((_, idx) => idx !== i))

  const addAction = () =>
    setField('actions', [...form.actions, { action_type: 'change_status', params: {} }])

  const updateAction = (i: number, updated: RuleAction) => {
    const next = [...form.actions]; next[i] = updated; setField('actions', next)
  }
  const removeAction = (i: number) =>
    setField('actions', form.actions.filter((_, idx) => idx !== i))

  // ── Validation ──
  const validate = (): boolean => {
    const errs: Record<string, string> = {}
    if (!form.name.trim()) errs.name = 'Name is required.'
    if (form.priority < 1 || form.priority > 999) errs.priority = 'Priority must be between 1 and 999.'
    if (form.actions.length === 0) errs.actions = 'At least one action is required.'
    setErrors(errs)
    return Object.keys(errs).length === 0
  }

  // ── Preview ──
  const handlePreview = async () => {
    setPreviewState('loading')
    setPreviewResult(null)
    try {
      const res = await crmApi.automationRules.preview({
        conditions: form.conditions,
        condition_logic: form.condition_logic,
        trigger_event: form.trigger_event,
      })
      const raw = res.data as { count: number; tickets: PreviewTicket[] }
      setPreviewResult(raw)
      setPreviewState('done')
    } catch {
      toast.error('Preview failed', 'Could not run preview against open tickets.')
      setPreviewState('idle')
    }
  }

  // ── Save ──
  const handleSave = () => {
    if (!validate()) return
    const body = {
      name: form.name.trim(),
      description: form.description.trim() || undefined,
      trigger_event: form.trigger_event,
      condition_logic: form.condition_logic,
      conditions: form.conditions,
      actions: form.actions,
      priority: form.priority,
      is_active: form.is_active,
    }
    if (isEdit) {
      updateMutation.mutate(body)
    } else {
      createMutation.mutate(body)
    }
  }

  const drawerTitle = isEdit
    ? `Edit: ${editingRule.name}`
    : prefillForm
      ? `Clone: ${prefillForm.name}`
      : 'Create Rule'

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40 z-40"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Drawer panel */}
      <div className="fixed right-0 top-0 h-screen w-[700px] bg-surface-card border-l border-surface-border shadow-2xl z-50 flex flex-col">

        {/* ── Header ── */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-border shrink-0">
          <h2 className="text-base font-semibold text-foreground">{drawerTitle}</h2>
          <button
            onClick={onClose}
            className="p-1.5 text-subtle hover:text-foreground transition-colors rounded-md hover:bg-surface-border"
            aria-label="Close drawer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* ── Scrollable body ── */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-7">

          {/* ═══ Section 1: Rule Info ═══ */}
          <section className="space-y-4">
            <SectionHeading>Rule Info</SectionHeading>
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2">
                <Input
                  label="Name *"
                  placeholder="e.g. Auto-escalate VIP tickets"
                  value={form.name}
                  onChange={e => setField('name', e.target.value)}
                  error={errors.name}
                />
              </div>
              <div className="col-span-2">
                <Textarea
                  label="Description (optional)"
                  placeholder="Describe what this rule does and when it should fire…"
                  value={form.description}
                  onChange={e => setField('description', e.target.value)}
                  className="min-h-[64px]"
                />
              </div>
              <div>
                <Input
                  label="Priority (1 = highest, runs first)"
                  type="number"
                  min={1}
                  max={999}
                  value={form.priority}
                  onChange={e => setField('priority', Number(e.target.value))}
                  error={errors.priority}
                />
              </div>
              <div className="flex items-end pb-1">
                <Switch
                  checked={form.is_active}
                  onCheckedChange={v => setField('is_active', v)}
                  label="Active"
                />
              </div>
            </div>
          </section>

          {/* ═══ Section 2: Trigger ═══ */}
          <section className="space-y-3">
            <SectionHeading accent="(Trigger)">When This Happens</SectionHeading>
            <div className="grid grid-cols-2 gap-2">
              {(Object.entries(TRIGGER_META) as [TriggerEvent, TriggerMeta][]).map(([key, meta]) => {
                const active = form.trigger_event === key
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setField('trigger_event', key)}
                    className={cn(
                      'flex items-start gap-3 p-3 rounded-lg border text-left transition-colors',
                      active
                        ? 'border-brand-500 bg-brand-500/10'
                        : 'border-surface-border hover:border-surface-muted hover:bg-surface/50'
                    )}
                  >
                    <span className={cn('mt-0.5 shrink-0', active ? 'text-brand-400' : 'text-subtle')}>
                      {meta.icon}
                    </span>
                    <div>
                      <p className={cn('text-sm font-medium', active ? 'text-foreground' : 'text-muted')}>
                        {meta.label}
                      </p>
                      <p className="text-xs text-subtle mt-0.5">{meta.description}</p>
                    </div>
                  </button>
                )
              })}
            </div>

            {form.trigger_event === 'TIME_BASED' && (
              <div className="mt-3 p-3 bg-surface/50 rounded-lg border border-surface-border space-y-2">
                <p className="text-xs font-medium text-muted">Time-based configuration</p>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm text-muted">Fire when</span>
                  <input
                    type="number"
                    min={1}
                    className={cn(
                      'w-20 bg-surface border border-surface-border rounded-md px-2 py-1.5 text-sm text-foreground',
                      'focus:outline-none focus:ring-1 focus:ring-brand-500 focus:border-brand-500'
                    )}
                    value={form.time_based_amount}
                    onChange={e => setField('time_based_amount', Number(e.target.value))}
                  />
                  <Select
                    options={[
                      { value: 'hours',   label: 'hours' },
                      { value: 'minutes', label: 'minutes' },
                    ]}
                    value={form.time_based_unit}
                    onChange={e => setField('time_based_unit', e.target.value as 'hours' | 'minutes')}
                  />
                  <span className="text-sm text-muted">after</span>
                  <Select
                    options={[
                      { value: 'created',              label: 'ticket created' },
                      { value: 'updated',              label: 'last updated' },
                      { value: 'first_response_due',   label: 'first response due' },
                    ]}
                    value={form.time_based_after}
                    onChange={e =>
                      setField('time_based_after', e.target.value as RuleFormState['time_based_after'])
                    }
                  />
                </div>
              </div>
            )}
          </section>

          {/* ═══ Section 3: Conditions ═══ */}
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <SectionHeading>If Conditions Are Met</SectionHeading>
              {/* AND / OR toggle pills */}
              <div className="flex items-center gap-0.5 bg-surface rounded-full p-0.5 border border-surface-border">
                {(['AND', 'OR'] as const).map(logic => (
                  <button
                    key={logic}
                    type="button"
                    onClick={() => setField('condition_logic', logic)}
                    className={cn(
                      'px-3 py-0.5 text-xs font-medium rounded-full transition-colors',
                      form.condition_logic === logic
                        ? 'bg-brand-600 text-white'
                        : 'text-muted hover:text-foreground'
                    )}
                  >
                    {logic === 'AND' ? 'AND — All must match' : 'OR — Any matches'}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              {form.conditions.length === 0 ? (
                <p className="text-sm text-subtle italic py-2">
                  No conditions — rule will match ALL tickets.
                </p>
              ) : (
                form.conditions.map((cond, i) => (
                  <ConditionRow
                    key={i}
                    condition={cond}
                    index={i}
                    onChange={updated => updateCondition(i, updated)}
                    onRemove={() => removeCondition(i)}
                  />
                ))
              )}
            </div>
            <Button variant="outline" size="sm" onClick={addCondition} type="button">
              <Plus className="w-3.5 h-3.5" />
              Add Condition
            </Button>
          </section>

          {/* ═══ Section 4: Actions ═══ */}
          <section className="space-y-3">
            <SectionHeading>Then Perform These Actions</SectionHeading>
            {errors.actions && <p className="text-xs text-red-400">{errors.actions}</p>}
            <div className="space-y-2">
              {form.actions.length === 0 ? (
                <p className="text-sm text-subtle italic py-2">No actions added yet.</p>
              ) : (
                form.actions.map((action, i) => (
                  <ActionRow
                    key={i}
                    action={action}
                    index={i}
                    groups={groups}
                    agents={agents}
                    onChange={updated => updateAction(i, updated)}
                    onRemove={() => removeAction(i)}
                  />
                ))
              )}
            </div>
            <Button variant="outline" size="sm" onClick={addAction} type="button">
              <Plus className="w-3.5 h-3.5" />
              Add Action
            </Button>
          </section>

          {/* ═══ Preview Results ═══ */}
          {previewState !== 'idle' && (
            <section className="space-y-3">
              <SectionHeading>Preview Results</SectionHeading>
              {previewState === 'loading' ? (
                <div className="flex items-center gap-2 text-sm text-muted py-2">
                  <Spinner size="sm" />
                  Testing against open tickets…
                </div>
              ) : previewResult ? (
                <div className="space-y-2">
                  <p className="text-sm font-medium text-foreground">
                    {previewResult.count} ticket{previewResult.count !== 1 ? 's' : ''} match these conditions
                  </p>
                  {previewResult.tickets.length > 0 ? (
                    <div className="overflow-x-auto border border-surface-border rounded-lg">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-surface-border bg-surface/50">
                            {['Ticket ID', 'Subject', 'Queue Type', 'Status', 'Priority', 'Created'].map(h => (
                              <th key={h} className="text-left px-3 py-2 text-subtle font-medium whitespace-nowrap">
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {previewResult.tickets.map(t => (
                            <tr
                              key={t.id}
                              className="border-b border-surface-border hover:bg-surface/30 last:border-0"
                            >
                              <td className="px-3 py-2 font-mono text-brand-400">#{t.id}</td>
                              <td className="px-3 py-2 text-foreground max-w-[160px] truncate">
                                {t.subject ?? '—'}
                              </td>
                              <td className="px-3 py-2 text-subtle">{t.queue_type.replace(/_/g, ' ')}</td>
                              <td className="px-3 py-2 text-subtle">{t.status.replace(/_/g, ' ')}</td>
                              <td className="px-3 py-2 text-subtle">
                                {PRIORITY_LABEL[String(t.priority)] ?? String(t.priority)}
                              </td>
                              <td className="px-3 py-2 text-subtle whitespace-nowrap">
                                {formatDate(t.created_at)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="text-sm text-subtle italic">No matching tickets found in the open queue.</p>
                  )}
                </div>
              ) : null}
            </section>
          )}
        </div>

        {/* ── Sticky Footer ── */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-surface-border bg-surface-card shrink-0">
          <Button variant="ghost" onClick={onClose} type="button">
            Cancel
          </Button>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              onClick={handlePreview}
              loading={previewState === 'loading'}
              type="button"
            >
              <PlayCircle className="w-4 h-4" />
              Preview Results
            </Button>
            <Button
              variant="primary"
              onClick={handleSave}
              loading={isSaving}
              type="button"
            >
              Save Rule
            </Button>
          </div>
        </div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// SectionHeading helper
// ---------------------------------------------------------------------------

function SectionHeading({
  children,
  accent,
}: {
  children: React.ReactNode
  accent?: string
}) {
  return (
    <h3 className="text-xs font-semibold text-subtle uppercase tracking-wider">
      {children}
      {accent && (
        <span className="ml-1.5 normal-case text-brand-400 font-normal tracking-normal">
          {accent}
        </span>
      )}
    </h3>
  )
}

// ---------------------------------------------------------------------------
// CRMAutomationPage (main export)
// ---------------------------------------------------------------------------

export default function CRMAutomationPage() {
  const qc = useQueryClient()

  const [filterTab, setFilterTab]   = useState<FilterTab>('all')
  const [search, setSearch]         = useState('')
  const [sortCol, setSortCol]       = useState<SortColumn>('priority')
  const [sortDir, setSortDir]       = useState<SortDir>('asc')
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editingRule, setEditingRule] = useState<AutomationRule | null>(null)
  const [prefillForm, setPrefillForm] = useState<RuleFormState | null>(null)

  // ── Queries ──────────────────────────────────────────────────────────────

  const { data: rulesRaw = [], isLoading: rulesLoading } = useQuery({
    queryKey: ['crm-automation-rules'],
    queryFn: () => crmApi.automationRules.list().then(r => r.data),
  })

  const { data: groupsRaw = [] } = useQuery({
    queryKey: ['crm-groups'],
    queryFn: () => crmApi.groups.list().then(r => r.data),
  })

  const { data: agentsRaw = [] } = useQuery({
    queryKey: ['crm-agents'],
    queryFn: () => crmApi.getAgents().then(r => r.data),
  })

  // ── Mutations ─────────────────────────────────────────────────────────────

  const toggleMutation = useMutation({
    mutationFn: (id: number) => crmApi.automationRules.toggle(id).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['crm-automation-rules'] })
      toast.success('Rule updated')
    },
    onError: () => toast.error('Toggle failed', 'Could not change the rule status.'),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => crmApi.automationRules.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['crm-automation-rules'] })
      toast.success('Rule deleted')
    },
    onError: () => toast.error('Delete failed', 'Could not delete the rule.'),
  })

  const bulkToggleMutation = useMutation({
    mutationFn: async ({ ids, activate }: { ids: number[]; activate: boolean }) => {
      for (const id of ids) {
        const rule = rulesRaw.find(r => r.id === id)
        if (rule && rule.is_active !== activate) {
          await crmApi.automationRules.toggle(id)
        }
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['crm-automation-rules'] })
      toast.success('Bulk update applied')
      setSelectedIds(new Set())
    },
    onError: () => toast.error('Bulk update failed'),
  })

  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids: number[]) => {
      for (const id of ids) {
        await crmApi.automationRules.delete(id)
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['crm-automation-rules'] })
      toast.success('Selected rules deleted')
      setSelectedIds(new Set())
    },
    onError: () => toast.error('Bulk delete failed'),
  })

  // ── Sort ──────────────────────────────────────────────────────────────────

  const handleSort = (col: SortColumn) => {
    if (sortCol === col) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortCol(col)
      setSortDir('asc')
    }
  }

  // ── Filter + Sort ─────────────────────────────────────────────────────────

  const filtered = rulesRaw
    .filter(r => {
      if (filterTab === 'event')    return r.trigger_event !== 'TIME_BASED' && r.is_active
      if (filterTab === 'time')     return r.trigger_event === 'TIME_BASED'
      if (filterTab === 'disabled') return !r.is_active
      return true
    })
    .filter(r =>
      !search.trim() || r.name.toLowerCase().includes(search.trim().toLowerCase())
    )
    .sort((a, b) => {
      let cmp = 0
      if (sortCol === 'priority') {
        cmp = a.priority - b.priority
      } else if (sortCol === 'name') {
        cmp = a.name.localeCompare(b.name)
      } else if (sortCol === 'run_count') {
        cmp = a.run_count - b.run_count
      } else if (sortCol === 'last_run_at') {
        const ta = a.last_run_at ? new Date(a.last_run_at).getTime() : 0
        const tb = b.last_run_at ? new Date(b.last_run_at).getTime() : 0
        cmp = ta - tb
      }
      return sortDir === 'asc' ? cmp : -cmp
    })

  // ── Stats ─────────────────────────────────────────────────────────────────

  const activeCount = rulesRaw.filter(r => r.is_active).length
  const seededCount = rulesRaw.filter(r => r.is_seeded).length
  const totalRuns   = rulesRaw.reduce((acc, r) => acc + r.run_count, 0)

  // ── Selection ─────────────────────────────────────────────────────────────

  const allPageSelected =
    filtered.length > 0 && filtered.every(r => selectedIds.has(r.id))
  const someSelected = selectedIds.size > 0

  const toggleSelectAll = () => {
    if (allPageSelected) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(filtered.map(r => r.id)))
    }
  }

  const toggleSelectRow = (id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // ── Drawer controls ───────────────────────────────────────────────────────

  const openCreate = () => {
    setEditingRule(null)
    setPrefillForm(null)
    setDrawerOpen(true)
  }

  const openEdit = (rule: AutomationRule) => {
    setEditingRule(rule)
    setPrefillForm(null)
    setDrawerOpen(true)
  }

  const handleClone = (rule: AutomationRule) => {
    const cloned = ruleToForm(rule)
    cloned.name     = `${rule.name} (Copy)`
    cloned.is_active = false
    setEditingRule(null)
    setPrefillForm(cloned)
    setDrawerOpen(true)
  }

  const closeDrawer = () => {
    setDrawerOpen(false)
    setEditingRule(null)
    setPrefillForm(null)
  }

  // ── Bulk delete confirm ───────────────────────────────────────────────────

  const handleBulkDelete = () => {
    const count = selectedIds.size
    if (
      window.confirm(
        `Delete ${count} selected rule${count !== 1 ? 's' : ''}? This cannot be undone.`
      )
    ) {
      bulkDeleteMutation.mutate(Array.from(selectedIds))
    }
  }

  const handleDeleteRow = (rule: AutomationRule) => {
    if (
      window.confirm(`Delete "${rule.name}"? This cannot be undone.`)
    ) {
      deleteMutation.mutate(rule.id)
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full">

      {/* ── Page Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between px-6 pt-6 pb-4 shrink-0">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Automation Rules</h1>
          <p className="text-sm text-muted mt-1">
            Automate ticket routing, escalation, and actions based on events and conditions
          </p>
        </div>
        <Button onClick={openCreate} size="md">
          <Plus className="w-4 h-4" />
          New Rule
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 pb-8 space-y-5">

        {/* ── Stats Row ─────────────────────────────────────────────────────── */}
        <div className="flex gap-3 flex-wrap">
          <StatCard
            label="Active Rules"
            value={activeCount}
            sub={`of ${rulesRaw.length} total`}
          />
          <StatCard
            label="Cardinal AI Rules"
            value={seededCount}
            sub="pre-seeded by Cardinal"
          />
          <StatCard
            label="Total Runs"
            value={totalRuns.toLocaleString()}
            sub="lifetime executions"
          />
        </div>

        {/* ── Filter Tabs + Search ───────────────────────────────────────────── */}
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-1 border-b border-surface-border">
            {FILTER_TABS.map(tab => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setFilterTab(tab.key)}
                className={cn(
                  'px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap',
                  filterTab === tab.key
                    ? 'border-brand-500 text-brand-400'
                    : 'border-transparent text-muted hover:text-foreground'
                )}
              >
                {tab.label}
                {tab.key === 'all' && (
                  <span className="ml-1.5 text-xs text-subtle">
                    ({rulesRaw.length})
                  </span>
                )}
              </button>
            ))}
          </div>

          <div className="relative w-64">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-subtle pointer-events-none" />
            <input
              type="text"
              placeholder="Search rules…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className={cn(
                'w-full bg-surface border border-surface-border rounded-md pl-9 pr-3 py-2 text-sm text-foreground',
                'placeholder:text-subtle focus:outline-none focus:ring-1 focus:ring-brand-500 focus:border-brand-500'
              )}
            />
          </div>
        </div>

        {/* ── Bulk Actions Bar ───────────────────────────────────────────────── */}
        {someSelected && (
          <div className="flex items-center gap-3 px-4 py-2.5 bg-brand-500/10 border border-brand-500/30 rounded-lg">
            <span className="text-sm font-medium text-brand-300">
              {selectedIds.size} rule{selectedIds.size !== 1 ? 's' : ''} selected
            </span>
            <div className="flex items-center gap-2 ml-auto">
              <Button
                variant="secondary"
                size="sm"
                loading={bulkToggleMutation.isPending}
                onClick={() =>
                  bulkToggleMutation.mutate({ ids: Array.from(selectedIds), activate: true })
                }
              >
                <ToggleRight className="w-3.5 h-3.5" />
                Enable All
              </Button>
              <Button
                variant="secondary"
                size="sm"
                loading={bulkToggleMutation.isPending}
                onClick={() =>
                  bulkToggleMutation.mutate({ ids: Array.from(selectedIds), activate: false })
                }
              >
                <ToggleLeft className="w-3.5 h-3.5" />
                Disable All
              </Button>
              <Button
                variant="danger"
                size="sm"
                loading={bulkDeleteMutation.isPending}
                onClick={handleBulkDelete}
              >
                <Trash2 className="w-3.5 h-3.5" />
                Delete Selected
              </Button>
            </div>
          </div>
        )}

        {/* ── Rules Table ────────────────────────────────────────────────────── */}
        <Card className="overflow-hidden">
          {rulesLoading ? (
            <div className="flex items-center justify-center py-16 gap-3 text-muted">
              <Spinner />
              <span className="text-sm">Loading automation rules…</span>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
              <Zap className="w-10 h-10 text-subtle" />
              <p className="text-sm font-medium text-muted">No rules found</p>
              <p className="text-xs text-subtle max-w-xs">
                {search
                  ? 'Try adjusting your search term.'
                  : 'Create your first automation rule to get started.'}
              </p>
              {!search && (
                <Button size="sm" onClick={openCreate} className="mt-2">
                  <Plus className="w-4 h-4" />
                  New Rule
                </Button>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-surface-border bg-surface/50">
                    {/* Select-all */}
                    <th className="w-10 px-3 py-3">
                      <button
                        type="button"
                        onClick={toggleSelectAll}
                        className="text-subtle hover:text-foreground"
                        aria-label="Select all"
                      >
                        {allPageSelected
                          ? <CheckSquare className="w-4 h-4 text-brand-400" />
                          : <Square className="w-4 h-4" />}
                      </button>
                    </th>

                    {/* Priority */}
                    <SortHeader
                      col="priority"
                      label="#"
                      sortCol={sortCol}
                      sortDir={sortDir}
                      onSort={handleSort}
                      className="w-12 text-left"
                    />

                    {/* Name */}
                    <SortHeader
                      col="name"
                      label="Name"
                      sortCol={sortCol}
                      sortDir={sortDir}
                      onSort={handleSort}
                      className="text-left"
                    />

                    <th className="text-left px-3 py-3 text-xs font-medium text-subtle whitespace-nowrap">
                      Trigger
                    </th>
                    <th className="text-left px-3 py-3 text-xs font-medium text-subtle whitespace-nowrap">
                      Conditions
                    </th>
                    <th className="text-left px-3 py-3 text-xs font-medium text-subtle whitespace-nowrap">
                      Actions
                    </th>
                    <th className="text-left px-3 py-3 text-xs font-medium text-subtle whitespace-nowrap">
                      Status
                    </th>

                    {/* Run count */}
                    <SortHeader
                      col="run_count"
                      label="Runs"
                      sortCol={sortCol}
                      sortDir={sortDir}
                      onSort={handleSort}
                      className="text-left whitespace-nowrap"
                    />

                    {/* Last run */}
                    <SortHeader
                      col="last_run_at"
                      label="Last Run"
                      sortCol={sortCol}
                      sortDir={sortDir}
                      onSort={handleSort}
                      className="text-left whitespace-nowrap"
                    />

                    <th className="w-28 px-3 py-3 text-xs font-medium text-subtle text-right">
                      Actions
                    </th>
                  </tr>
                </thead>

                <tbody>
                  {filtered.map((rule, idx) => (
                    <tr
                      key={rule.id}
                      className={cn(
                        'border-b border-surface-border transition-colors hover:bg-surface/40',
                        selectedIds.has(rule.id) && 'bg-brand-500/5',
                        idx === filtered.length - 1 && 'border-0'
                      )}
                    >
                      {/* Checkbox */}
                      <td className="px-3 py-3">
                        <button
                          type="button"
                          onClick={() => toggleSelectRow(rule.id)}
                          className="text-subtle hover:text-foreground"
                        >
                          {selectedIds.has(rule.id)
                            ? <CheckSquare className="w-4 h-4 text-brand-400" />
                            : <Square className="w-4 h-4" />}
                        </button>
                      </td>

                      {/* Priority */}
                      <td className="px-2 py-3">
                        <span className="text-xs text-subtle tabular-nums font-medium">
                          {rule.priority}
                        </span>
                      </td>

                      {/* Name + description + Cardinal badge */}
                      <td className="px-3 py-3 max-w-[220px]">
                        <div className="flex flex-col gap-0.5">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-sm font-medium text-foreground truncate">
                              {rule.name}
                            </span>
                            {rule.is_seeded && (
                              <Badge
                                variant="purple"
                                className="flex items-center gap-0.5 shrink-0"
                              >
                                <Zap className="w-2.5 h-2.5" />
                                Cardinal
                              </Badge>
                            )}
                          </div>
                          {rule.description && (
                            <p className="text-xs text-subtle truncate max-w-[200px]">
                              {rule.description}
                            </p>
                          )}
                        </div>
                      </td>

                      {/* Trigger */}
                      <td className="px-3 py-3">
                        <TriggerBadge event={rule.trigger_event} />
                      </td>

                      {/* Conditions */}
                      <td className="px-3 py-3">
                        <span className="text-xs text-muted">
                          {conditionsSummary(rule.conditions, rule.condition_logic)}
                        </span>
                      </td>

                      {/* Actions */}
                      <td className="px-3 py-3">
                        <span className="text-xs text-muted">
                          {actionsSummary(rule.actions)}
                        </span>
                      </td>

                      {/* Status toggle */}
                      <td className="px-3 py-3">
                        <Switch
                          checked={rule.is_active}
                          onCheckedChange={() => toggleMutation.mutate(rule.id)}
                          disabled={toggleMutation.isPending}
                        />
                      </td>

                      {/* Run count */}
                      <td className="px-3 py-3">
                        <span className="text-xs tabular-nums text-foreground">
                          {rule.run_count.toLocaleString()}
                        </span>
                      </td>

                      {/* Last run */}
                      <td className="px-3 py-3">
                        <span className="text-xs text-muted whitespace-nowrap">
                          {formatDate(rule.last_run_at)}
                        </span>
                      </td>

                      {/* Row action buttons */}
                      <td className="px-3 py-3">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            type="button"
                            title="Edit rule"
                            onClick={() => openEdit(rule)}
                            className="p-1.5 rounded text-subtle hover:text-foreground hover:bg-surface-border transition-colors"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            title="Clone rule"
                            onClick={() => handleClone(rule)}
                            className="p-1.5 rounded text-subtle hover:text-foreground hover:bg-surface-border transition-colors"
                          >
                            <Copy className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            title="Delete rule"
                            onClick={() => handleDeleteRow(rule)}
                            disabled={deleteMutation.isPending}
                            className="p-1.5 rounded text-subtle hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                          >
                            {deleteMutation.isPending
                              ? <Spinner size="sm" />
                              : <Trash2 className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {!rulesLoading && filtered.length > 0 && (
          <p className="text-xs text-subtle">
            Showing {filtered.length} of {rulesRaw.length} rule{rulesRaw.length !== 1 ? 's' : ''}
          </p>
        )}
      </div>

      {/* ── Rule Editor Drawer ──────────────────────────────────────────────── */}
      {drawerOpen && (
        <RuleEditor
          editingRule={editingRule}
          prefillForm={prefillForm}
          groups={groupsRaw}
          agents={agentsRaw}
          onClose={closeDrawer}
          onSaved={closeDrawer}
        />
      )}
    </div>
  )
}
