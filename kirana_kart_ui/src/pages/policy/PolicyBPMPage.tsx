/**
 * PolicyBPMPage — Policy Lifecycle Governance Board
 *
 * Shows all version instances for the active KB, grouped by status:
 *   🟡 In Progress | ✅ Published | ❌ Rejected/Failed
 *
 * Non-technical language throughout. No BPM stage names shown to users —
 * only plain-English status summaries.
 */

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, GitBranch, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useKBStore } from '@/stores/kb.store'
import { useAuthStore } from '@/stores/auth.store'
import { hasPermission } from '@/lib/access'
import { bpmApi, type BPMInstance } from '@/api/governance/bpm.api'
import { VersionCard } from './components/VersionCard'
import { BPMStageDrawer } from './components/BPMStageDrawer'
import { VersionWizard } from './components/VersionWizard'
import { PolicyValueIntro } from './components/PolicyValueIntro'
import { MLHealthPanel } from './components/MLHealthPanel'
import { CLOSED_STAGES } from './stages'

export default function PolicyBPMPage() {
  const { activeKbId, getActiveKB } = useKBStore()
  const { user } = useAuthStore()
  const qc = useQueryClient()

  const [selectedInstance, setSelectedInstance] = useState<BPMInstance | null>(null)
  const [showWizard, setShowWizard] = useState(false)
  const [resumeEntity, setResumeEntity] = useState<string | null>(null)

  const canEdit  = hasPermission(user, 'policy', 'edit')
  const canAdmin = hasPermission(user, 'policy', 'admin') || !!user?.is_super_admin
  const activeKB = getActiveKB()

  const { data: instances = [], isLoading, refetch } = useQuery({
    queryKey: ['bpm', 'instances', activeKbId],
    queryFn: () => bpmApi.listInstances(activeKbId, { limit: 100 }).then((r) => r.data),
    enabled: !!activeKbId,
    refetchInterval: 30_000, // refresh every 30s for in-progress gates
  })

  const inProgress = instances.filter((i) => i.current_stage !== 'ACTIVE' && !CLOSED_STAGES.includes(i.current_stage))
  const published  = instances.filter((i) => i.current_stage === 'ACTIVE')
  const retired    = instances.filter((i) => CLOSED_STAGES.includes(i.current_stage))

  return (
    <div className="max-w-4xl mx-auto py-8 px-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-brand-50 dark:bg-brand-900/20 rounded-xl flex items-center justify-center">
            <GitBranch className="w-5 h-5 text-brand-600" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-foreground">Policy Studio</h1>
            <p className="text-sm text-muted">
              {activeKB ? activeKB.kb_name : activeKbId} — design, test and govern business decisions
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => refetch()}
            className="p-2 text-muted hover:text-foreground hover:bg-surface-card rounded-lg border border-surface-border transition-colors"
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          {canEdit && (
            <button
              onClick={() => { setResumeEntity(null); setShowWizard(true) }}
              className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 transition-colors"
            >
              <Plus className="w-4 h-4" />
              Create policy change
            </button>
          )}
        </div>
      </div>

      <PolicyValueIntro />

      {isLoading && (
        <div className="flex justify-center py-16">
          <div className="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {/* In Progress */}
      {inProgress.length > 0 && (
        <Section
          emoji="🟡"
          title="In Progress"
          count={inProgress.length}
          className="mb-6"
        >
          {inProgress.map((inst) => (
            <VersionCard
              key={inst.id}
              instance={inst}
              onOpen={() => setSelectedInstance(inst)}
              canAdmin={canAdmin}
              kbId={activeKbId}
            />
          ))}
        </Section>
      )}

      {/* Active / Published */}
      <Section
        emoji="✅"
        title="Live"
        count={published.length}
        className="mb-6"
      >
        {published.length === 0 && (
          <p className="text-sm text-muted py-4 text-center">No version is live yet.</p>
        )}
        {published.map((inst) => (
          <VersionCard
            key={inst.id}
            instance={inst}
            onOpen={() => setSelectedInstance(inst)}
            canAdmin={canAdmin}
            kbId={activeKbId}
          />
        ))}
      </Section>

      {/* Retired / Rejected */}
      {retired.length > 0 && (
        <Section
          emoji="❌"
          title="Needs attention / Retired"
          count={retired.length}
          collapsible
          className="mb-6"
        >
          {retired.map((inst) => (
            <VersionCard
              key={inst.id}
              instance={inst}
              onOpen={() => setSelectedInstance(inst)}
              canAdmin={canAdmin}
              kbId={activeKbId}
            />
          ))}
        </Section>
      )}

      {/* Stage drawer */}
      {selectedInstance && (
        <BPMStageDrawer
          instance={selectedInstance}
          kbId={activeKbId}
          canAdmin={canAdmin}
          canEdit={canEdit}
          onResume={() => { setResumeEntity(selectedInstance.entity_id); setSelectedInstance(null); setShowWizard(true) }}
          onClose={() => setSelectedInstance(null)}
          onRefresh={() => {
            qc.invalidateQueries({ queryKey: ['bpm', 'instances', activeKbId] })
            setSelectedInstance(null)
          }}
        />
      )}

      {/* ML Health Panel — admin only */}
      {canAdmin && (
        <details className="bg-surface-card border border-surface-border rounded-xl p-5 mb-6">
          <summary className="cursor-pointer text-sm font-medium mb-3">Advanced: model diagnostics</summary>
          <MLHealthPanel kbId={activeKbId} canAdmin={canAdmin} />
        </details>
      )}

      {/* New version wizard */}
      {showWizard && (
        <VersionWizard
          kbId={activeKbId}
          resumeEntityId={resumeEntity ?? undefined}
          onClose={() => { setShowWizard(false); qc.invalidateQueries({ queryKey: ['bpm', 'instances', activeKbId] }) }}
          onCreated={() => {
            qc.invalidateQueries({ queryKey: ['bpm', 'instances', activeKbId] })
            setShowWizard(false)
          }}
        />
      )}
    </div>
  )
}

// ---- Section helper ----

interface SectionProps {
  emoji: string
  title: string
  count: number
  children: React.ReactNode
  collapsible?: boolean
  className?: string
}

function Section({ emoji, title, count, children, collapsible = false, className }: SectionProps) {
  const [open, setOpen] = useState(!collapsible)

  return (
    <div className={cn('bg-surface-card border border-surface-border rounded-xl overflow-hidden', className)}>
      <button
        onClick={() => collapsible && setOpen((o) => !o)}
        className={cn(
          'w-full flex items-center justify-between px-5 py-3',
          'border-b border-surface-border',
          collapsible ? 'cursor-pointer hover:bg-surface/50' : 'cursor-default',
        )}
      >
        <div className="flex items-center gap-2">
          <span>{emoji}</span>
          <span className="text-sm font-semibold text-foreground">{title}</span>
          <span className="text-xs text-muted bg-surface px-2 py-0.5 rounded-full border border-surface-border">
            {count}
          </span>
        </div>
        {collapsible && (
          <span className="text-xs text-muted">{open ? 'Collapse' : 'Show'}</span>
        )}
      </button>

      {open && (
        <div className="divide-y divide-surface-border">
          {children}
        </div>
      )}
    </div>
  )
}
