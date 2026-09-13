// src/pages/cardinal/CardinalPage.tsx
// =====================================
// Cardinal Intelligence — main 7-tab page.
// Access: cardinal.view (default-deny for new users; admin must grant).

import { useState } from 'react'
import { PageHeader } from '@/components/layout/PageHeader'
import { cn } from '@/lib/cn'
import { useAuthStore } from '@/stores/auth.store'
import { hasPermission } from '@/lib/access'
import { Activity, Layers, Cpu, Wrench, Clock, ListChecks, FileText } from 'lucide-react'
import { OverviewTab }        from './tabs/OverviewTab'
import { PhaseAnalysisTab }   from './tabs/PhaseAnalysisTab'
import { ExecutionTab }       from './tabs/ExecutionTab'
import { OperationsTab }      from './tabs/OperationsTab'
import { SchedulersTab }      from './tabs/SchedulersTab'
import { ActionRegistryTab }  from './tabs/ActionRegistryTab'
import { TemplatesTab }       from './tabs/TemplatesTab'

type Tab = 'overview' | 'phases' | 'executions' | 'operations' | 'schedulers' | 'action-registry' | 'templates'

const TABS: { key: Tab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: 'overview',         label: 'Pipeline Overview', icon: Activity },
  { key: 'phases',           label: 'Phase Analysis',    icon: Layers },
  { key: 'executions',       label: 'LLM Execution',     icon: Cpu },
  { key: 'operations',       label: 'Operations',        icon: Wrench },
  { key: 'schedulers',       label: 'Schedulers',        icon: Clock },
  { key: 'action-registry',  label: 'Action Registry',   icon: ListChecks },
  { key: 'templates',        label: 'Templates',         icon: FileText },
]

export default function CardinalPage() {
  const [activeTab, setActiveTab] = useState<Tab>('overview')
  const user = useAuthStore((s) => s.user)
  const canAdmin = hasPermission(user, 'cardinal', 'admin')

  return (
    <div>
      <PageHeader
        title="Cardinal Intelligence"
        subtitle="Observe the 5-phase ingest pipeline and 4-stage LLM execution chain in real time"
      />

      {/* Tab bar */}
      <div className="flex gap-1 mb-4 border-b border-surface-border overflow-x-auto">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              'flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap',
              activeTab === tab.key
                ? 'border-brand-500 text-brand-400'
                : 'border-transparent text-muted hover:text-foreground',
            )}
          >
            <tab.icon className="w-3.5 h-3.5" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'overview'        && <OverviewTab />}
      {activeTab === 'phases'          && <PhaseAnalysisTab />}
      {activeTab === 'executions'      && <ExecutionTab />}
      {activeTab === 'operations'      && <OperationsTab />}
      {activeTab === 'schedulers'      && <SchedulersTab />}
      {activeTab === 'action-registry' && <ActionRegistryTab canAdmin={canAdmin} />}
      {activeTab === 'templates'       && <TemplatesTab canAdmin={canAdmin} />}
    </div>
  )
}
