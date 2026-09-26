/**
 * RuleEnforcementPanel — how Policy Studio rules took part in live decisions.
 *
 * In observe mode (RULE_ENFORCEMENT=observe) rules only record what they
 * would have decided; this panel is the evidence for switching to enforce.
 */

import { useQuery } from '@tanstack/react-query'
import { Scale } from 'lucide-react'
import { bpmApi } from '@/api/governance/bpm.api'
import { apiErrorMessage } from '@/lib/api-error'

export function RuleEnforcementPanel() {
  const summary = useQuery({
    queryKey: ['bpm', 'rule-decisions', 7],
    queryFn: () => bpmApi.getRuleDecisionSummary(7).then(r => r.data),
    refetchInterval: 60_000,
  })
  const data = summary.data && typeof summary.data.evaluated === 'number' ? summary.data : undefined
  const pct = (n: number) => (data && data.evaluated ? `${Math.round((n / data.evaluated) * 100)}%` : '—')

  return (
    <section aria-labelledby="rule-enforcement-heading" className="bg-surface-card border border-surface-border rounded-xl p-5 mb-6">
      <div className="flex items-center gap-2 mb-2">
        <Scale className="w-4 h-4 text-muted" />
        <h2 id="rule-enforcement-heading" className="text-sm font-semibold text-foreground">Rules in live decisions</h2>
        {data && (
          <span className={data.mode === 'enforce'
            ? 'ml-auto text-xs px-2 py-0.5 rounded-full bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 font-medium'
            : 'ml-auto text-xs px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 font-medium'}>
            {data.mode === 'enforce' ? 'Enforced: rules decide' : 'Observe only: rules do not change decisions'}
          </span>
        )}
      </div>

      {summary.isLoading && <p className="text-sm text-muted">Loading…</p>}
      {summary.isError && <p role="alert" className="text-sm text-red-600">{apiErrorMessage(summary.error, 'Rule decision evidence could not be loaded.')}</p>}

      {data && (data.evaluated === 0 ? (
        <p role="status" className="text-sm text-muted">No tickets have been evaluated against the live policy's rules in the last {data.days} days.</p>
      ) : (
        <>
          <p className="text-sm text-foreground/80 mb-3">
            {data.mode === 'enforce'
              ? `Last ${data.days} days: ${data.evaluated} tickets evaluated. A rule matched and decided ${data.applied} (${pct(data.applied)}); on ${data.differs} (${pct(data.differs)}) the rule's decision differed from the AI's proposal.`
              : `Last ${data.days} days: ${data.evaluated} tickets evaluated. A rule matched ${data.matched} (${pct(data.matched)}); on ${data.differs} (${pct(data.differs)}) it would have decided differently from the AI.`}
          </p>
          {data.by_rule.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead><tr className="text-xs text-muted"><th className="py-1 pr-3">Rule</th><th className="py-1 pr-3">Action</th><th className="py-1 pr-3">Matched</th><th className="py-1">Differs from AI</th></tr></thead>
                <tbody>
                  {data.by_rule.map(r => (
                    <tr key={r.rule_id} className="border-t border-surface-border">
                      <td className="py-1 pr-3 font-mono text-xs break-all">{r.rule_id}</td>
                      <td className="py-1 pr-3">{r.rule_action ?? '—'}</td>
                      <td className="py-1 pr-3">{r.matched}</td>
                      <td className="py-1">{r.differs}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ))}
      <p className="text-xs text-muted mt-3">
        {data?.mode === 'enforce'
          ? 'The first matching rule sets the action and any amount it states; fraud, tier and review checks still apply afterwards.'
          : 'Switch RULE_ENFORCEMENT to enforce once these differences match what the policy intends.'}
      </p>
    </section>
  )
}
