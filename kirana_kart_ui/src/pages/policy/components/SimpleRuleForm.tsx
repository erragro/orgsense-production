/**
 * SimpleRuleForm — guided modal form for adding or editing a rule.
 *
 * Uses dropdowns + toggles. No JSON editing exposed to the user.
 * Uses ConditionBuilder for the conditions section.
 */

import { useState } from 'react'
import { useMutation,useQuery,useQueryClient } from '@tanstack/react-query'
import { X,Loader2,AlertTriangle,Info } from 'lucide-react'
import { cn } from '@/lib/cn'
import { ruleApi,type Rule,type RuleCreate,type ActionCode } from '@/api/governance/rule-editor.api'
import { taxonomyApi } from '@/api/governance/taxonomy.api'
import { ConditionBuilder,isCondition,emptyConditions,conditionSummary,type Condition } from './ConditionBuilder'

interface Props {
  kbId: string
  policyVersion: string
  /** Pass an existing rule to edit; null to create a new one */
  rule: Rule | null
  actionCodes: ActionCode[]
  onClose: () => void
  onSaved: () => void
}

const PRIORITY_LABELS = [
  { value: 100, label: 'Critical (100)' },
  { value: 300, label: 'High (300)' },
  { value: 500, label: 'Normal (500)' },
  { value: 700, label: 'Low (700)' },
  { value: 900, label: 'Very Low (900)' },
]

const SEGMENT_OPTIONS = ['Normal', 'Silver', 'Gold', 'Platinum']
const FRAUD_SEGMENT_OPTIONS = ['NORMAL', 'SUSPICIOUS', 'HIGH', 'VERY_HIGH']

export function SimpleRuleForm({ kbId, policyVersion, rule, actionCodes, onClose, onSaved }: Props) {
  const qc = useQueryClient()
  const isEdit = rule !== null

  // Form state
  const [issueL1, setIssueL1] = useState(rule?.issue_type_l1 ?? '')
  const [issueL2, setIssueL2] = useState(rule?.issue_type_l2 ?? '')
  const [actionId, setActionId] = useState<number>(rule?.action_id ?? (actionCodes[0]?.id ?? 0))
  const [priority, setPriority] = useState(rule?.priority ?? 500)
  const [segment, setSegment] = useState(rule?.customer_segment ?? '')
  const [fraudSegment, setFraudSegment] = useState(rule?.fraud_segment ?? '')
  const [minOrder, setMinOrder] = useState<string>(rule?.min_order_value?.toString() ?? '')
  const [maxOrder, setMaxOrder] = useState<string>(rule?.max_order_value?.toString() ?? '')
  const [slaRequired, setSlaRequired] = useState(rule?.sla_breach_required ?? false)
  const [evidenceRequired, setEvidenceRequired] = useState(rule?.evidence_required ?? false)
  const [deterministic, setDeterministic] = useState(rule?.deterministic ?? true)
  const [overrideable, setOverrideable] = useState(rule?.overrideable ?? false)
  const unsupportedConditions = rule?.conditions != null && !isCondition(rule.conditions)
  const [conditions, setConditions] = useState<Condition>(
    () => (isCondition(rule?.conditions)
      ? rule!.conditions
      : emptyConditions()),
  )
  const [error, setError] = useState('')

  // Taxonomy query for issue type dropdowns
  const { data: taxonomyIssues = [] } = useQuery({
    queryKey: ['taxonomy', 'issues'],
    queryFn: () => taxonomyApi.getAll().then((r) => r.data),
    retry: false,
  })

  const l1Issues = taxonomyIssues.filter((i) => !i.parent_id)
  const l2Issues = taxonomyIssues.filter(
    (i) => i.parent_id && l1Issues.find((p) => p.issue_code === issueL1 && p.id === i.parent_id),
  )

  const selectedAction = actionCodes.find((a) => a.id === actionId)

  const mutation = useMutation({
    mutationFn: () => {
      if (unsupportedConditions) throw new Error("This rule needs a condition-format review before editing.")
      const payload: RuleCreate = {
        policy_version: policyVersion,
        issue_type_l1: issueL1,
        issue_type_l2: issueL2 || null,
        action_id: actionId,
        priority,
        customer_segment: segment || null,
        fraud_segment: fraudSegment || null,
        min_order_value: minOrder ? Number(minOrder) : null,
        max_order_value: maxOrder ? Number(maxOrder) : null,
        sla_breach_required: slaRequired,
        evidence_required: evidenceRequired,
        deterministic,
        overrideable,
        conditions: { ...conditions },
      }
      return isEdit
        ? ruleApi.updateRule(kbId, rule!.id, payload)
        : ruleApi.createRule(kbId, payload)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['rules', kbId, policyVersion] })
      onSaved()
    },
    onError: (e: Error) => setError(e.message ?? 'Save failed. Please try again.'),
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (unsupportedConditions) { setError('This rule needs a condition-format review before editing.'); return }
    if (!issueL1) { setError('Please select an issue type.'); return }
    if (!actionId) { setError('Please select an action.'); return }
    mutation.mutate()
  }

  // Group action codes by category
  const actionsByCategory = actionCodes.reduce<Record<string, ActionCode[]>>((acc, a) => {
    const cat = a.action_category ?? 'Other'
    if (!acc[cat]) acc[cat] = []
    acc[cat].push(a)
    return acc
  }, {})

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50" onClick={onClose} />
      <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
        <div className="bg-surface-card border border-surface-border rounded-2xl shadow-2xl w-full max-w-xl max-h-[90vh] overflow-y-auto">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-surface-border sticky top-0 bg-surface-card z-10">
            <h2 className="text-base font-semibold text-foreground">
              {isEdit ? 'Edit Rule' : 'Add New Rule'}
            </h2>
            <button onClick={onClose} className="text-muted hover:text-foreground transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>

          <form onSubmit={handleSubmit} className="p-6 space-y-5">
            {/* Issue type */}
            <div>
              <label className="block text-sm font-medium text-foreground mb-1.5">
                What type of issue does this rule apply to?
              </label>
              {l1Issues.length > 0 ? (
                <div className="flex gap-2">
                  <select
                    value={issueL1}
                    onChange={(e) => { setIssueL1(e.target.value); setIssueL2('') }}
                    className={cn(
                      'flex-1 bg-surface-card border border-surface-border rounded-lg px-3 py-2 text-sm text-foreground',
                      'focus:outline-none focus:ring-2 focus:ring-brand-500',
                    )}
                  >
                    <option value="">Select issue category...</option>
                    {l1Issues.map((i) => (
                      <option key={i.id} value={i.issue_code}>{i.label}</option>
                    ))}
                  </select>
                  {l2Issues.length > 0 && (
                    <select
                      value={issueL2}
                      onChange={(e) => setIssueL2(e.target.value)}
                      className={cn(
                        'flex-1 bg-surface-card border border-surface-border rounded-lg px-3 py-2 text-sm text-foreground',
                        'focus:outline-none focus:ring-2 focus:ring-brand-500',
                      )}
                    >
                      <option value="">All sub-types</option>
                      {l2Issues.map((i) => (
                        <option key={i.id} value={i.issue_code}>{i.label}</option>
                      ))}
                    </select>
                  )}
                </div>
              ) : (
                <input
                  type="text"
                  value={issueL1}
                  onChange={(e) => setIssueL1(e.target.value)}
                  placeholder="e.g. FOOD_SAFETY"
                  className={cn(
                    'w-full bg-surface-card border border-surface-border rounded-lg px-3 py-2 text-sm text-foreground',
                    'focus:outline-none focus:ring-2 focus:ring-brand-500',
                  )}
                />
              )}
            </div>

            {/* Action */}
            <div>
              <label className="block text-sm font-medium text-foreground mb-1.5">
                What action should be taken?
              </label>
              <select
                value={actionId}
                onChange={(e) => setActionId(Number(e.target.value))}
                className={cn(
                  'w-full bg-surface-card border border-surface-border rounded-lg px-3 py-2 text-sm text-foreground',
                  'focus:outline-none focus:ring-2 focus:ring-brand-500',
                )}
              >
                <option value={0}>Select action...</option>
                {Object.entries(actionsByCategory).map(([cat, codes]) => (
                  <optgroup key={cat} label={cat}>
                    {codes.map((a) => (
                      <option key={a.id} value={a.id}>{a.action_name}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
              {selectedAction?.requires_approval && (
                <p className="text-xs text-amber-600 mt-1 flex items-center gap-1">
                  <Info className="w-3 h-3" /> This action requires manager approval before executing.
                </p>
              )}
            </div>

            {/* Priority */}
            <div>
              <label className="block text-sm font-medium text-foreground mb-1.5">
                Priority (who wins when multiple rules match?)
              </label>
              <div className="flex gap-2 flex-wrap">
                {PRIORITY_LABELS.map((p) => (
                  <button
                    key={p.value}
                    type="button"
                    onClick={() => setPriority(p.value)}
                    className={cn(
                      'px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors',
                      priority === p.value
                        ? 'bg-brand-600 text-white border-brand-600'
                        : 'bg-surface border-surface-border text-muted hover:text-foreground',
                    )}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Conditions */}
            <div>
              <label className="block text-sm font-medium text-foreground mb-1.5">
                When does this rule apply? (optional conditions)
              </label>
              {unsupportedConditions ? <div role="alert" className="rounded-lg border border-amber-300 p-3 text-sm space-y-2">
                <p>This rule uses a condition format this editor cannot safely interpret. Saving is disabled to protect the existing conditions. Ask a policy administrator to review and migrate this rule.</p>
                <details><summary className="cursor-pointer">View original conditions</summary><pre className="whitespace-pre-wrap break-all text-xs mt-2">{JSON.stringify(rule?.conditions, null, 2)}</pre></details>
              </div> : <ConditionBuilder value={conditions} onChange={setConditions} />}
            </div>

            {/* Order value range */}
            <div>
              <label className="block text-sm font-medium text-foreground mb-1.5">
                Order value range (optional)
              </label>
              <div className="flex gap-3 items-center">
                <div className="flex-1">
                  <label className="text-xs text-muted mb-1 block">Minimum (₹)</label>
                  <input
                    type="number"
                    value={minOrder}
                    onChange={(e) => setMinOrder(e.target.value)}
                    placeholder="No minimum"
                    className={cn(
                      'w-full bg-surface-card border border-surface-border rounded-lg px-3 py-2 text-sm text-foreground',
                      'focus:outline-none focus:ring-2 focus:ring-brand-500',
                    )}
                  />
                </div>
                <span className="text-muted mt-5">–</span>
                <div className="flex-1">
                  <label className="text-xs text-muted mb-1 block">Maximum (₹)</label>
                  <input
                    type="number"
                    value={maxOrder}
                    onChange={(e) => setMaxOrder(e.target.value)}
                    placeholder="No maximum"
                    className={cn(
                      'w-full bg-surface-card border border-surface-border rounded-lg px-3 py-2 text-sm text-foreground',
                      'focus:outline-none focus:ring-2 focus:ring-brand-500',
                    )}
                  />
                </div>
              </div>
            </div>

            {/* Customer & fraud segment */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-muted mb-1">Customer segment (optional)</label>
                <select
                  value={segment}
                  onChange={(e) => setSegment(e.target.value)}
                  className={cn(
                    'w-full bg-surface-card border border-surface-border rounded-lg px-3 py-2 text-sm text-foreground',
                    'focus:outline-none focus:ring-2 focus:ring-brand-500',
                  )}
                >
                  <option value="">Any</option>
                  {SEGMENT_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs text-muted mb-1">Fraud risk (optional)</label>
                <select
                  value={fraudSegment}
                  onChange={(e) => setFraudSegment(e.target.value)}
                  className={cn(
                    'w-full bg-surface-card border border-surface-border rounded-lg px-3 py-2 text-sm text-foreground',
                    'focus:outline-none focus:ring-2 focus:ring-brand-500',
                  )}
                >
                  <option value="">Any</option>
                  {FRAUD_SEGMENT_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            </div>

            {/* Flags */}
            <div className="space-y-2">
              <label className="block text-sm font-medium text-foreground mb-1">Rule flags</label>
              {[
                { label: 'SLA must be breached for this rule to apply', value: slaRequired, set: setSlaRequired },
                { label: 'Evidence (photos / docs) required from customer', value: evidenceRequired, set: setEvidenceRequired },
                { label: 'Apply automatically (no human review needed)', value: deterministic, set: setDeterministic },
                { label: 'Support agents can override this rule', value: overrideable, set: setOverrideable },
              ].map(({ label, value, set }) => (
                <label key={label} className="flex items-center gap-3 cursor-pointer group">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={value}
                    onClick={() => set(!value)}
                    className={cn(
                      'relative w-9 h-5 rounded-full transition-colors shrink-0',
                      value ? 'bg-brand-600' : 'bg-surface-border',
                    )}
                  >
                    <span className={cn(
                      'absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform',
                      value ? 'translate-x-4' : 'translate-x-0',
                    )} />
                  </button>
                  <span className="text-sm text-muted group-hover:text-foreground transition-colors">{label}</span>
                </label>
              ))}
            </div>

            {/* Plain-English summary */}
            {!unsupportedConditions && issueL1 && selectedAction && (
              <div className="bg-blue-50 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-700 rounded-lg p-3">
                <p className="text-xs text-blue-700 dark:text-blue-300 font-medium mb-1">This rule means:</p>
                <p className="text-sm text-blue-800 dark:text-blue-200 italic">
                  "When a {segment || 'customer'} reports a {issueL1.replace(/_/g, ' ').toLowerCase()} issue
                  {conditions && (conditions as { conditions?: unknown[] }).conditions?.length
                    ? ` and ${conditionSummary(conditions)}`
                    : ''}, {selectedAction.action_name.toLowerCase()}."
                </p>
              </div>
            )}

            {error && (
              <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 dark:bg-red-900/10 border border-red-200 rounded-lg p-3">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                {error}
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 py-2.5 text-sm border border-surface-border rounded-lg text-foreground hover:bg-surface transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={mutation.isPending || unsupportedConditions}
                className="flex-1 py-2.5 text-sm bg-brand-600 text-white rounded-lg font-medium hover:bg-brand-700 disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
              >
                {mutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                {isEdit ? 'Save Changes' : 'Add Rule'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  )
}
