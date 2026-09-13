/**
 * RuleEditorPage — full rule table for a KB + policy version.
 *
 * Accessible from the BPM board drawer (RULE_EDIT stage) via query params:
 *   /policy/rules?kb=food_delivery&version=v2.1
 *
 * Features:
 *  - Plain-English rule cards (not raw JSON)
 *  - Add rule (SimpleRuleForm guided form)
 *  - Edit rule (SimpleRuleForm pre-filled)
 *  - Delete rule (confirmation inline)
 *  - Validate (conflict/duplicate check via Model B stub)
 *  - Diff summary: "3 added, 2 changed vs active version"
 */

import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Plus, Search, Trash2, Pencil, AlertTriangle, CheckCircle2,
  Loader2, ShieldCheck, BarChart2, RefreshCw,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { ruleApi, type Rule } from '@/api/governance/rule-editor.api'
import { useKBStore } from '@/stores/kb.store'
import { useAuthStore } from '@/stores/auth.store'
import { hasPermission } from '@/lib/access'
import { SimpleRuleForm } from './components/SimpleRuleForm'

// Priority badge color
const priorityColor = (p: number) => {
  if (p <= 150) return 'bg-red-100 dark:bg-red-900/20 text-red-600'
  if (p <= 350) return 'bg-orange-100 dark:bg-orange-900/20 text-orange-600'
  if (p <= 550) return 'bg-blue-100 dark:bg-blue-900/20 text-blue-600'
  return 'bg-surface text-muted border border-surface-border'
}

const priorityLabel = (p: number) => {
  if (p <= 150) return 'Critical'
  if (p <= 350) return 'High'
  if (p <= 550) return 'Normal'
  return 'Low'
}

// ---- Rule row card ----

function RuleCard({
  rule,
  canEdit,
  onEdit,
  onDelete,
}: {
  rule: Rule
  canEdit: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  const [confirmDelete, setConfirmDelete] = useState(false)

  return (
    <div className="bg-surface-card border border-surface-border rounded-xl p-4 group">
      {/* Top row */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-mono text-muted">{rule.rule_id}</span>
            <span className={cn('text-xs px-2 py-0.5 rounded-full font-medium', priorityColor(rule.priority))}>
              {priorityLabel(rule.priority)}
            </span>
            {rule.deterministic && (
              <span className="text-xs px-1.5 py-0.5 rounded-full bg-green-50 dark:bg-green-900/20 text-green-600 border border-green-200 dark:border-green-700">
                Auto
              </span>
            )}
            {rule.overrideable && (
              <span className="text-xs px-1.5 py-0.5 rounded-full bg-amber-50 dark:bg-amber-900/20 text-amber-600 border border-amber-200 dark:border-amber-700">
                Overrideable
              </span>
            )}
          </div>

          {/* Issue type + action */}
          <div className="mt-2">
            <span className="text-xs px-2 py-0.5 rounded-full bg-blue-50 dark:bg-blue-900/20 text-blue-600 font-medium">
              {rule.issue_type_l1}{rule.issue_type_l2 ? ` › ${rule.issue_type_l2}` : ''}
            </span>
            <span className="text-xs text-muted mx-2">→</span>
            <span className="text-sm font-semibold text-foreground">{rule.action_name}</span>
          </div>

          {/* Conditions summary */}
          <div className="mt-1.5 flex flex-wrap gap-2 text-xs text-muted">
            {rule.min_order_value != null && (
              <span className="bg-surface px-1.5 py-0.5 rounded border border-surface-border">
                Order ≥ ₹{rule.min_order_value}
              </span>
            )}
            {rule.max_order_value != null && (
              <span className="bg-surface px-1.5 py-0.5 rounded border border-surface-border">
                Order ≤ ₹{rule.max_order_value}
              </span>
            )}
            {rule.customer_segment && (
              <span className="bg-surface px-1.5 py-0.5 rounded border border-surface-border">
                {rule.customer_segment} customers
              </span>
            )}
            {rule.fraud_segment && rule.fraud_segment !== 'NORMAL' && (
              <span className="bg-surface px-1.5 py-0.5 rounded border border-surface-border">
                Fraud: {rule.fraud_segment.toLowerCase().replace('_', ' ')}
              </span>
            )}
            {rule.sla_breach_required && (
              <span className="bg-surface px-1.5 py-0.5 rounded border border-surface-border">
                SLA breached
              </span>
            )}
            {rule.evidence_required && (
              <span className="bg-surface px-1.5 py-0.5 rounded border border-surface-border">
                Evidence required
              </span>
            )}
          </div>
        </div>

        {/* Actions */}
        {canEdit && !confirmDelete && (
          <div className="flex gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={onEdit}
              className="p-1.5 text-muted hover:text-foreground hover:bg-surface rounded-lg transition-colors"
              title="Edit rule"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setConfirmDelete(true)}
              className="p-1.5 text-muted hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors"
              title="Delete rule"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* Delete confirmation */}
      {confirmDelete && (
        <div className="mt-3 flex items-center gap-3 bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-700 rounded-lg px-3 py-2">
          <AlertTriangle className="w-4 h-4 text-red-500 shrink-0" />
          <span className="text-xs text-red-600 flex-1">Delete this rule permanently?</span>
          <button
            onClick={() => setConfirmDelete(false)}
            className="text-xs text-muted hover:text-foreground transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => { setConfirmDelete(false); onDelete() }}
            className="text-xs font-medium text-red-600 hover:text-red-700 transition-colors"
          >
            Delete
          </button>
        </div>
      )}
    </div>
  )
}

// ---- Validation result banner ----

function ValidationBanner({ kbId, version }: { kbId: string; version: string }) {
  const { data } = useQuery({
    queryKey: ['rules', kbId, version, 'validate'],
    queryFn: () => ruleApi.validateRules(kbId, version).then((r) => r.data),
    staleTime: 30_000,
  })

  if (!data || (data.warnings.length === 0 && data.conflicts.length === 0 && data.duplicates.length === 0)) {
    return (
      <div className="flex items-center gap-2 text-sm text-green-600 bg-green-50 dark:bg-green-900/10 border border-green-200 dark:border-green-700 rounded-lg px-3 py-2">
        <CheckCircle2 className="w-4 h-4 shrink-0" />
        {data?.model_status === 'not_trained'
          ? 'No conflicts detected (AI conflict checker will be available after training data is collected).'
          : 'No conflicts or duplicates found.'}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {data.conflicts.map((c, i) => (
        <div key={i} className="flex items-center gap-2 text-sm text-red-600 bg-red-50 dark:bg-red-900/10 border border-red-200 rounded-lg px-3 py-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {c.message}
        </div>
      ))}
      {data.duplicates.map((d, i) => (
        <div key={i} className="flex items-center gap-2 text-sm text-amber-600 bg-amber-50 dark:bg-amber-900/10 border border-amber-200 rounded-lg px-3 py-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          Possible duplicate: {d.rule_ids.join(' & ')} (similarity {(d.score * 100).toFixed(0)}%)
        </div>
      ))}
    </div>
  )
}

// ---- Main page ----

export default function RuleEditorPage() {
  const [searchParams] = useSearchParams()
  const { activeKbId } = useKBStore()
  const { user } = useAuthStore()
  const qc = useQueryClient()

  const kbId = searchParams.get('kb') || activeKbId
  const version = searchParams.get('version') ?? ''
  const canEdit = hasPermission(user, 'policy', 'edit')

  const [search, setSearch] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [editRule, setEditRule] = useState<Rule | null>(null)

  const { data: rules = [], isLoading, refetch } = useQuery({
    queryKey: ['rules', kbId, version],
    queryFn: () => ruleApi.listRules(kbId, version).then((r) => r.data),
    enabled: !!kbId && !!version,
  })

  const { data: actionCodes = [] } = useQuery({
    queryKey: ['rules', kbId, 'action-codes'],
    queryFn: () => ruleApi.listActionCodes(kbId).then((r) => r.data),
    enabled: !!kbId,
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => ruleApi.deleteRule(kbId, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rules', kbId, version] }),
  })

  const filtered = rules.filter((r) => {
    if (!search) return true
    const q = search.toLowerCase()
    return (
      r.rule_id.toLowerCase().includes(q) ||
      r.issue_type_l1.toLowerCase().includes(q) ||
      (r.issue_type_l2 ?? '').toLowerCase().includes(q) ||
      r.action_name.toLowerCase().includes(q)
    )
  })

  if (!version) {
    return (
      <div className="max-w-4xl mx-auto py-12 px-4 text-center">
        <p className="text-muted text-sm">No policy version selected. Navigate here from the BPM board.</p>
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto py-8 px-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Policy Rules</h1>
          <p className="text-sm text-muted mt-0.5">
            <span className="font-mono text-xs">{kbId}</span>
            {' · '}
            <span className="font-mono text-xs">{version}</span>
            {' · '}
            {rules.length} rule{rules.length !== 1 ? 's' : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => refetch()}
            className="p-2 text-muted hover:text-foreground hover:bg-surface-card rounded-lg border border-surface-border transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          {canEdit && (
            <button
              onClick={() => { setEditRule(null); setShowForm(true) }}
              className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 transition-colors"
            >
              <Plus className="w-4 h-4" /> Add Rule
            </button>
          )}
        </div>
      </div>

      {/* Validation banner */}
      {rules.length > 0 && (
        <div className="mb-4">
          <ValidationBanner kbId={kbId} version={version} />
        </div>
      )}

      {/* Search */}
      {rules.length > 3 && (
        <div className="relative mb-4">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search rules by issue type, action, or rule ID..."
            className={cn(
              'w-full pl-9 pr-4 py-2.5 bg-surface-card border border-surface-border rounded-lg text-sm text-foreground',
              'placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-brand-500',
            )}
          />
        </div>
      )}

      {/* Rules */}
      {isLoading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-brand-500" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16">
          {rules.length === 0 ? (
            <div className="space-y-3">
              <ShieldCheck className="w-10 h-10 text-muted mx-auto" />
              <p className="text-sm text-muted">No rules yet. Add your first rule to get started.</p>
              {canEdit && (
                <button
                  onClick={() => { setEditRule(null); setShowForm(true) }}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 transition-colors"
                >
                  <Plus className="w-4 h-4" /> Add First Rule
                </button>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted">No rules match your search.</p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((rule) => (
            <RuleCard
              key={rule.id}
              rule={rule}
              canEdit={canEdit}
              onEdit={() => { setEditRule(rule); setShowForm(true) }}
              onDelete={() => deleteMutation.mutate(rule.id)}
            />
          ))}
        </div>
      )}

      {/* Rule count summary */}
      {rules.length > 0 && (
        <div className="mt-6 flex items-center gap-2 text-xs text-muted">
          <BarChart2 className="w-3.5 h-3.5" />
          {rules.length} rule{rules.length !== 1 ? 's' : ''} total
          {search && filtered.length !== rules.length && ` · ${filtered.length} shown`}
        </div>
      )}

      {/* Form modal */}
      {showForm && (
        <SimpleRuleForm
          kbId={kbId}
          policyVersion={version}
          rule={editRule}
          actionCodes={actionCodes}
          onClose={() => setShowForm(false)}
          onSaved={() => setShowForm(false)}
        />
      )}
    </div>
  )
}
