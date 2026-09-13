import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card'
import { Select } from '@/components/ui/Select'
import { EmptyState } from '@/components/common/EmptyState'
import { kbApi } from '@/api/governance/kb.api'
import { cn } from '@/lib/cn'
import type { RuleEntry } from '@/types/kb.types'
import { ChevronDown, ChevronRight } from 'lucide-react'

interface Props {
  initialVersion?: string
}

export function RulesTab({ initialVersion }: Props) {
  const [version, setVersion] = useState(initialVersion ?? '')
  const [moduleFilter, setModuleFilter] = useState('all')
  const [typeFilter, setTypeFilter] = useState('all')
  const [expandedId, setExpandedId] = useState<number | null>(null)

  const { data: versions } = useQuery({
    queryKey: ['kb', 'versions'],
    queryFn: () => kbApi.getVersions().then((r) => r.data),
  })

  const { data: rules, isLoading } = useQuery({
    queryKey: ['kb', 'rules', version],
    queryFn: () => kbApi.getRules(version).then((r) => r.data),
    enabled: !!version,
  })

  const modules = ['all', ...Array.from(new Set(rules?.map((r) => r.module_name) ?? []))]
  const types = ['all', ...Array.from(new Set(rules?.map((r) => r.rule_type) ?? []))]

  const filtered = (rules ?? []).filter(
    (r) =>
      (moduleFilter === 'all' || r.module_name === moduleFilter) &&
      (typeFilter === 'all' || r.rule_type === typeFilter)
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 items-end">
        <div className="w-48">
          <Select
            label="Version"
            options={[
              { value: '', label: 'Select version…' },
              ...(versions ?? []).map((v) => ({
                value: v.version_label,
                label: v.version_label,
              })),
            ]}
            value={version}
            onChange={(e) => {
              setVersion(e.target.value)
              setModuleFilter('all')
              setTypeFilter('all')
            }}
          />
        </div>

        {rules && rules.length > 0 && (
          <>
            <div className="w-44">
              <Select
                label="Module"
                options={modules.map((m) => ({ value: m, label: m === 'all' ? 'All Modules' : m }))}
                value={moduleFilter}
                onChange={(e) => setModuleFilter(e.target.value)}
              />
            </div>
            <div className="w-44">
              <Select
                label="Rule Type"
                options={types.map((t) => ({ value: t, label: t === 'all' ? 'All Types' : t }))}
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
              />
            </div>
          </>
        )}

        {filtered.length > 0 && (
          <p className="text-xs text-subtle pb-1">{filtered.length} rules</p>
        )}
      </div>

      <Card>
        <CardHeader><CardTitle>Decision Matrix</CardTitle></CardHeader>
        <CardContent className="p-0">
          {!version ? (
            <EmptyState title="Select a version" description="Choose a policy version above to view its compiled rules." />
          ) : isLoading ? (
            <div className="px-4 py-6 text-sm text-subtle text-center">Loading…</div>
          ) : !filtered.length ? (
            <EmptyState title="No rules found" description="No compiled rules match the current filters." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-surface-border">
                    <th className="w-6 px-2 py-2" />
                    <th className="text-left px-4 py-2 text-subtle font-medium">Module</th>
                    <th className="text-left px-4 py-2 text-subtle font-medium hidden sm:table-cell">Issue L1</th>
                    <th className="text-left px-4 py-2 text-subtle font-medium hidden md:table-cell">Issue L2</th>
                    <th className="text-left px-4 py-2 text-subtle font-medium">Action</th>
                    <th className="text-right px-4 py-2 text-subtle font-medium">Priority</th>
                    <th className="text-center px-3 py-2 text-subtle font-medium hidden lg:table-cell">Type</th>
                    <th className="text-center px-3 py-2 text-subtle font-medium hidden lg:table-cell">Det.</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((rule) => (
                    <RuleRow
                      key={rule.id}
                      rule={rule}
                      expanded={expandedId === rule.id}
                      onToggle={() => setExpandedId(expandedId === rule.id ? null : rule.id)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}


function RuleRow({
  rule,
  expanded,
  onToggle,
}: {
  rule: RuleEntry
  expanded: boolean
  onToggle: () => void
}) {
  const hasDetails =
    Object.keys(rule.conditions ?? {}).length > 0 ||
    Object.keys(rule.action_payload ?? {}).length > 0

  return (
    <>
      <tr
        className={cn(
          'border-b border-surface-border cursor-pointer hover:bg-surface/50 transition-colors',
          expanded && 'bg-surface/30'
        )}
        onClick={onToggle}
      >
        <td className="w-6 px-2 py-2.5 text-subtle">
          {hasDetails ? (
            expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />
          ) : null}
        </td>
        <td className="px-4 py-2.5 text-foreground font-medium">{rule.module_name}</td>
        <td className="px-4 py-2.5 text-subtle hidden sm:table-cell">{rule.issue_type_l1 ?? '—'}</td>
        <td className="px-4 py-2.5 text-subtle hidden md:table-cell">{rule.issue_type_l2 ?? '—'}</td>
        <td className="px-4 py-2.5">
          <span className="font-mono text-brand-400">{rule.action_code_id}</span>
          <span className="text-subtle ml-1.5">{rule.action_name}</span>
        </td>
        <td className="px-4 py-2.5 text-right text-foreground tabular-nums">{rule.priority}</td>
        <td className="px-3 py-2.5 text-center text-subtle hidden lg:table-cell">{rule.rule_type}</td>
        <td className="px-3 py-2.5 text-center hidden lg:table-cell">
          {rule.deterministic ? (
            <span className="text-green-400">✓</span>
          ) : (
            <span className="text-subtle">—</span>
          )}
        </td>
      </tr>

      {expanded && (
        <tr className="border-b border-surface-border bg-surface/20">
          <td />
          <td colSpan={7} className="px-4 py-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {Object.keys(rule.conditions ?? {}).length > 0 && (
                <JsonBlock label="Conditions" data={rule.conditions} />
              )}
              {Object.keys(rule.action_payload ?? {}).length > 0 && (
                <JsonBlock label="Action Payload" data={rule.action_payload} />
              )}
              {(rule.min_order_value != null || rule.max_order_value != null ||
                rule.min_repeat_count != null || rule.max_repeat_count != null) && (
                <JsonBlock label="Numeric Constraints" data={{
                  min_order_value: rule.min_order_value,
                  max_order_value: rule.max_order_value,
                  min_repeat_count: rule.min_repeat_count,
                  max_repeat_count: rule.max_repeat_count,
                }} />
              )}
              <div className="text-xs text-subtle space-y-1">
                {rule.business_line && <div>Business line: <span className="text-foreground">{rule.business_line}</span></div>}
                {rule.customer_segment && <div>Customer segment: <span className="text-foreground">{rule.customer_segment}</span></div>}
                {rule.fraud_segment && <div>Fraud segment: <span className="text-foreground">{rule.fraud_segment}</span></div>}
                <div>SLA breach required: <span className="text-foreground">{rule.sla_breach_required ? 'Yes' : 'No'}</span></div>
                <div>Evidence required: <span className="text-foreground">{rule.evidence_required ? 'Yes' : 'No'}</span></div>
                <div>Overrideable: <span className="text-foreground">{rule.overrideable ? 'Yes' : 'No'}</span></div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function JsonBlock({ label, data }: { label: string; data: unknown }) {
  return (
    <div>
      <p className="text-xs text-subtle mb-1">{label}</p>
      <pre className="text-xs font-mono bg-surface rounded p-2 overflow-auto text-foreground max-h-40">
        {JSON.stringify(data, null, 2)}
      </pre>
    </div>
  )
}
