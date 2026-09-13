/**
 * ConditionBuilder — visual AND/OR block editor for rule conditions.
 *
 * Produces a plain-English preview: "Only if order value ≥ ₹200 AND customer is Gold"
 * Output is a nested JSON object compatible with the rule_registry.conditions schema.
 */

import { Plus, Trash2 } from 'lucide-react'
import { cn } from '@/lib/cn'

// ---- Types ----

export type ConditionOperator = 'AND' | 'OR'

export interface LeafCondition {
  type: 'leaf'
  field: string
  op: string    // 'gte' | 'lte' | 'eq' | 'in' | 'true'
  value: string | number | string[] | boolean
}

export interface GroupCondition {
  type: 'group'
  operator: ConditionOperator
  conditions: Condition[]
}

export type Condition = LeafCondition | GroupCondition

// ---- Field catalogue ----

const FIELDS: Array<{ value: string; label: string; ops: Array<{ value: string; label: string }>; valueType: 'number' | 'text' | 'select' | 'boolean'; options?: string[] }> = [
  {
    value: 'order_value',
    label: 'Order value (₹)',
    ops: [{ value: 'gte', label: 'is at least' }, { value: 'lte', label: 'is at most' }],
    valueType: 'number',
  },
  {
    value: 'customer_segment',
    label: 'Customer segment',
    ops: [{ value: 'eq', label: 'is' }, { value: 'in', label: 'is one of' }],
    valueType: 'select',
    options: ['Normal', 'Silver', 'Gold', 'Platinum'],
  },
  {
    value: 'fraud_segment',
    label: 'Fraud risk',
    ops: [{ value: 'eq', label: 'is' }],
    valueType: 'select',
    options: ['NORMAL', 'SUSPICIOUS', 'HIGH', 'VERY_HIGH'],
  },
  {
    value: 'repeat_count',
    label: 'Number of previous complaints',
    ops: [{ value: 'gte', label: 'at least' }, { value: 'lte', label: 'at most' }],
    valueType: 'number',
  },
  {
    value: 'sla_breach',
    label: 'SLA was breached',
    ops: [{ value: 'eq', label: 'is' }],
    valueType: 'boolean',
  },
  {
    value: 'business_line',
    label: 'Business line',
    ops: [{ value: 'eq', label: 'is' }],
    valueType: 'text',
  },
]

const DEFAULT_LEAF: LeafCondition = {
  type: 'leaf',
  field: 'order_value',
  op: 'gte',
  value: 0,
}

// ---- Plain-English summary ----

export function conditionSummary(c: Condition): string {
  if (c.type === 'leaf') {
    const fd = FIELDS.find((f) => f.value === c.field)
    const label = fd?.label ?? c.field
    const opLabel = fd?.ops.find((o) => o.value === c.op)?.label ?? c.op
    if (c.field === 'sla_breach') return 'SLA has been breached'
    if (Array.isArray(c.value)) return `${label} ${opLabel} ${c.value.join(', ')}`
    return `${label} ${opLabel} ${c.value}`
  }
  return c.conditions.map(conditionSummary).join(` ${c.operator} `)
}

// ---- Leaf editor ----

function LeafEditor({
  cond,
  onChange,
  onRemove,
}: {
  cond: LeafCondition
  onChange: (c: LeafCondition) => void
  onRemove: () => void
}) {
  const fd = FIELDS.find((f) => f.value === cond.field) ?? FIELDS[0]

  const handleFieldChange = (field: string) => {
    const newFd = FIELDS.find((f) => f.value === field) ?? FIELDS[0]
    const defaultVal = newFd.valueType === 'number' ? 0 : newFd.valueType === 'boolean' ? true : ''
    onChange({ ...cond, field, op: newFd.ops[0].value, value: defaultVal })
  }

  return (
    <div className="flex items-center gap-2 flex-wrap bg-surface rounded-lg px-3 py-2 border border-surface-border">
      {/* Field selector */}
      <select
        value={cond.field}
        onChange={(e) => handleFieldChange(e.target.value)}
        className="bg-surface-card border border-surface-border text-sm text-foreground rounded-md px-2 py-1 focus:outline-none focus:ring-2 focus:ring-brand-500"
      >
        {FIELDS.map((f) => (
          <option key={f.value} value={f.value}>{f.label}</option>
        ))}
      </select>

      {/* Operator */}
      <select
        value={cond.op}
        onChange={(e) => onChange({ ...cond, op: e.target.value })}
        className="bg-surface-card border border-surface-border text-sm text-foreground rounded-md px-2 py-1 focus:outline-none focus:ring-2 focus:ring-brand-500"
      >
        {fd.ops.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>

      {/* Value */}
      {fd.valueType === 'number' && (
        <input
          type="number"
          value={cond.value as number}
          onChange={(e) => onChange({ ...cond, value: Number(e.target.value) })}
          className="w-24 bg-surface-card border border-surface-border text-sm text-foreground rounded-md px-2 py-1 focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
      )}
      {fd.valueType === 'text' && (
        <input
          type="text"
          value={cond.value as string}
          onChange={(e) => onChange({ ...cond, value: e.target.value })}
          className="w-32 bg-surface-card border border-surface-border text-sm text-foreground rounded-md px-2 py-1 focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
      )}
      {fd.valueType === 'select' && (
        <select
          value={cond.value as string}
          onChange={(e) => onChange({ ...cond, value: e.target.value })}
          className="bg-surface-card border border-surface-border text-sm text-foreground rounded-md px-2 py-1 focus:outline-none focus:ring-2 focus:ring-brand-500"
        >
          {fd.options?.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
      )}
      {fd.valueType === 'boolean' && (
        <span className="text-sm text-foreground italic">(condition always applies)</span>
      )}

      <button
        type="button"
        onClick={onRemove}
        className="ml-auto text-muted hover:text-red-500 transition-colors"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}

// ---- Group editor (recursive) ----

function GroupEditor({
  group,
  onChange,
  onRemove,
  depth,
}: {
  group: GroupCondition
  onChange: (g: GroupCondition) => void
  onRemove?: () => void
  depth: number
}) {
  const updateChild = (index: number, updated: Condition) => {
    const conditions = [...group.conditions]
    conditions[index] = updated
    onChange({ ...group, conditions })
  }

  const removeChild = (index: number) => {
    onChange({ ...group, conditions: group.conditions.filter((_, i) => i !== index) })
  }

  const addLeaf = () => {
    onChange({ ...group, conditions: [...group.conditions, { ...DEFAULT_LEAF }] })
  }

  const addGroup = () => {
    onChange({
      ...group,
      conditions: [
        ...group.conditions,
        { type: 'group', operator: 'AND', conditions: [{ ...DEFAULT_LEAF }] } as GroupCondition,
      ],
    })
  }

  return (
    <div className={cn(
      'rounded-xl border p-3 space-y-2',
      depth === 0
        ? 'border-surface-border bg-surface-card'
        : 'border-brand-200 dark:border-brand-700 bg-brand-50/30 dark:bg-brand-900/10',
    )}>
      {/* Operator toggle + remove */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted font-medium">Match</span>
        <button
          type="button"
          onClick={() => onChange({ ...group, operator: group.operator === 'AND' ? 'OR' : 'AND' })}
          className={cn(
            'px-2 py-0.5 rounded text-xs font-semibold border transition-colors',
            group.operator === 'AND'
              ? 'bg-brand-600 text-white border-brand-600'
              : 'bg-amber-500 text-white border-amber-500',
          )}
        >
          {group.operator === 'AND' ? 'ALL conditions' : 'ANY condition'}
        </button>
        <span className="text-xs text-muted">below</span>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="ml-auto text-muted hover:text-red-500 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Children */}
      {group.conditions.length === 0 && (
        <p className="text-xs text-muted text-center py-2">No conditions yet — add one below.</p>
      )}
      {group.conditions.map((child, i) => (
        <div key={i}>
          {child.type === 'leaf' ? (
            <LeafEditor
              cond={child}
              onChange={(updated) => updateChild(i, updated)}
              onRemove={() => removeChild(i)}
            />
          ) : (
            <GroupEditor
              group={child}
              onChange={(updated) => updateChild(i, updated)}
              onRemove={() => removeChild(i)}
              depth={depth + 1}
            />
          )}
        </div>
      ))}

      {/* Add buttons */}
      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={addLeaf}
          className="flex items-center gap-1 text-xs text-brand-600 hover:text-brand-700 transition-colors"
        >
          <Plus className="w-3 h-3" /> Add condition
        </button>
        {depth < 2 && (
          <button
            type="button"
            onClick={addGroup}
            className="flex items-center gap-1 text-xs text-muted hover:text-foreground transition-colors"
          >
            <Plus className="w-3 h-3" /> Add group
          </button>
        )}
      </div>
    </div>
  )
}

// ---- Root export ----

interface ConditionBuilderProps {
  value: Condition
  onChange: (c: Condition) => void
}

export function ConditionBuilder({ value, onChange }: ConditionBuilderProps) {
  // If root isn't a group, wrap it
  const root: GroupCondition =
    value.type === 'group'
      ? value
      : { type: 'group', operator: 'AND', conditions: [value] }

  return (
    <div className="space-y-2">
      <GroupEditor
        group={root}
        onChange={onChange}
        depth={0}
      />
      {root.conditions.length > 0 && (
        <p className="text-xs text-muted italic px-1">
          Plain English: "{conditionSummary(root)}"
        </p>
      )}
    </div>
  )
}

/** Construct an empty root group for a new rule */
export function emptyConditions(): GroupCondition {
  return { type: 'group', operator: 'AND', conditions: [] }
}

/** Validate persisted condition trees before handing them to the visual editor. */
export function isCondition(value: unknown): value is Condition {
  if (!value || typeof value !== 'object') return false
  const node = value as Record<string, unknown>
  if (node.type === 'group') {
    return (node.operator === 'AND' || node.operator === 'OR') &&
      Array.isArray(node.conditions) && node.conditions.every(isCondition)
  }
  return node.type === 'leaf' && typeof node.field === 'string' && typeof node.op === 'string' &&
    (typeof node.value === 'string' || typeof node.value === 'number' || typeof node.value === 'boolean' ||
      (Array.isArray(node.value) && node.value.every(v => typeof v === 'string')))
}
