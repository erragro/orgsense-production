import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { PageHeader } from '@/components/layout/PageHeader'
import { VersionBadge } from '@/components/common/VersionBadge'
import { kbApi } from '@/api/governance/kb.api'
import { useAuthStore } from '@/stores/auth.store'
import { hasPermission } from '@/lib/access'
import { cn } from '@/lib/cn'
import { FileText, GitBranch, Workflow, Code2, Table2 } from 'lucide-react'

import { DocumentsTab } from './tabs/DocumentsTab'
import { PipelineTab } from './tabs/PipelineTab'
import { VersionsTab } from './tabs/VersionsTab'
import { ActionCodesTab } from './tabs/ActionCodesTab'
import { RulesTab } from './tabs/RulesTab'

type Tab = 'documents' | 'pipeline' | 'versions' | 'action-codes' | 'rules'

export default function KBPage() {
  const [activeTab, setActiveTab] = useState<Tab>('documents')
  const [rulesVersion, setRulesVersion] = useState<string | undefined>()

  const user = useAuthStore((s) => s.user)
  const canEdit = hasPermission(user, 'knowledgeBase', 'edit')
  const canAdmin = hasPermission(user, 'knowledgeBase', 'admin')

  const { data: activeVersion } = useQuery({
    queryKey: ['kb', 'active-version'],
    queryFn: () => kbApi.getActiveVersion().then((r) => r.data),
  })

  const handleViewRules = (version: string) => {
    setRulesVersion(version)
    setActiveTab('rules')
  }

  const TABS = [
    { key: 'documents' as const, label: 'Documents', icon: FileText },
    { key: 'pipeline' as const, label: 'Pipeline', icon: Workflow },
    { key: 'versions' as const, label: 'Versions', icon: GitBranch },
    { key: 'action-codes' as const, label: 'Action Codes', icon: Code2 },
    { key: 'rules' as const, label: 'Decision Matrix', icon: Table2 },
  ]

  return (
    <div>
      <PageHeader
        title="Knowledge Base"
        subtitle="Upload, compile, vectorize, and manage KB policy documents"
        actions={activeVersion && <VersionBadge version={activeVersion.active_version} isActive />}
      />

      <div className="flex gap-1 mb-4 border-b border-surface-border overflow-x-auto">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              'flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap',
              activeTab === tab.key
                ? 'border-brand-500 text-brand-400'
                : 'border-transparent text-muted hover:text-foreground'
            )}
          >
            <tab.icon className="w-3.5 h-3.5" />
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'documents' && <DocumentsTab canEdit={canEdit} />}
      {activeTab === 'pipeline' && <PipelineTab canAdmin={canAdmin} />}
      {activeTab === 'versions' && (
        <VersionsTab canAdmin={canAdmin} onViewRules={handleViewRules} />
      )}
      {activeTab === 'action-codes' && <ActionCodesTab canAdmin={canAdmin} />}
      {activeTab === 'rules' && <RulesTab initialVersion={rulesVersion} />}
    </div>
  )
}
