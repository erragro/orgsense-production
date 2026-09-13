import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { StatusPill } from '@/components/common/StatusPill'
import { VersionBadge } from '@/components/common/VersionBadge'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { EmptyState } from '@/components/common/EmptyState'
import { Skeleton } from '@/components/ui/Skeleton'
import { Input } from '@/components/ui/Input'
import { Textarea } from '@/components/ui/Textarea'
import { Switch } from '@/components/ui/Switch'
import { taxonomyApi } from '@/api/governance/taxonomy.api'
import { toast } from '@/stores/toast.store'
import { useAuthStore } from '@/stores/auth.store'
import { formatDate } from '@/lib/dates'
import { cn } from '@/lib/cn'
import type { TaxonomyIssue } from '@/types/taxonomy.types'
import { TreeDeciduous, Plus, RefreshCw, GitBranch, History } from 'lucide-react'

type Tab = 'tree' | 'drafts' | 'versions'

export default function TaxonomyPage() {
  const [activeTab, setActiveTab] = useState<Tab>('tree')
  const [includeInactive, setIncludeInactive] = useState(false)
  const [selectedIssue, setSelectedIssue] = useState<TaxonomyIssue | null>(null)
  const [addingNew, setAddingNew] = useState(false)
  const [publishLabel, setPublishLabel] = useState('')
  const [showPublishDialog, setShowPublishDialog] = useState(false)
  const [rollbackTarget, setRollbackTarget] = useState<string | null>(null)
  const { user } = useAuthStore()
  const qc = useQueryClient()

  const canEdit = !!(user?.is_super_admin || user?.permissions.taxonomy?.edit)
  const canPublish = !!(user?.is_super_admin || user?.permissions.taxonomy?.admin)

  // Queries
  const { data: issues, isLoading } = useQuery({
    queryKey: ['taxonomy', 'list', { include_inactive: includeInactive }],
    queryFn: () => taxonomyApi.getAll(includeInactive).then((r) => r.data),
  })

  const { data: versions } = useQuery({
    queryKey: ['taxonomy', 'versions'],
    queryFn: () => taxonomyApi.getVersions().then((r) => r.data),
    enabled: activeTab === 'versions',
  })

  const { data: activeVersion } = useQuery({
    queryKey: ['taxonomy', 'active-version'],
    queryFn: () => taxonomyApi.getActiveVersion().then((r) => r.data),
  })

  // Mutations
  const deactivateMut = useMutation({
    mutationFn: (code: string) => taxonomyApi.deactivate(code),
    onSuccess: () => {
      toast.success('Issue deactivated')
      void qc.invalidateQueries({ queryKey: ['taxonomy'] })
    },
    onError: () => toast.error('Failed to deactivate'),
  })

  const reactivateMut = useMutation({
    mutationFn: (code: string) => taxonomyApi.reactivate(code),
    onSuccess: () => {
      toast.success('Issue reactivated')
      void qc.invalidateQueries({ queryKey: ['taxonomy'] })
    },
    onError: () => toast.error('Failed to reactivate'),
  })

  const publishMut = useMutation({
    mutationFn: (label: string) => taxonomyApi.publish(label),
    onSuccess: () => {
      toast.success('Taxonomy published', `Version ${publishLabel} is now active`)
      setShowPublishDialog(false)
      void qc.invalidateQueries({ queryKey: ['taxonomy'] })
    },
    onError: () => toast.error('Publish failed'),
  })

  const rollbackMut = useMutation({
    mutationFn: (label: string) => taxonomyApi.rollback(label),
    onSuccess: () => {
      toast.success('Rolled back successfully')
      setRollbackTarget(null)
      void qc.invalidateQueries({ queryKey: ['taxonomy'] })
    },
    onError: () => toast.error('Rollback failed'),
  })

  const vectorizeMut = useMutation({
    mutationFn: () => taxonomyApi.vectorizeActive(),
    onSuccess: () => toast.success('Vectorization started for active version'),
    onError: () => toast.error('Vectorization failed'),
  })

  // Build tree structure
  const buildTree = (items: TaxonomyIssue[]) => {
    const l1 = items.filter((i) => i.level === 1)
    return l1
  }

  const getChildren = (items: TaxonomyIssue[], parentId: number) =>
    items.filter((i) => i.parent_id === parentId)

  const IssueRow = ({ issue, depth = 0 }: { issue: TaxonomyIssue; depth?: number }) => {
    const children = issues ? getChildren(issues, issue.id) : []
    const [expanded, setExpanded] = useState(depth < 2)

    return (
      <div>
        <div
          className={cn(
            'flex items-center gap-2 px-3 py-2 hover:bg-surface rounded-md cursor-pointer transition-colors',
            selectedIssue?.id === issue.id && 'bg-brand-600/10 border border-brand-600/20',
            !issue.is_active && 'opacity-50'
          )}
          style={{ paddingLeft: `${12 + depth * 20}px` }}
          onClick={() => setSelectedIssue(issue)}
        >
          {children.length > 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); setExpanded(!expanded) }}
              className="w-3.5 h-3.5 text-subtle hover:text-foreground shrink-0"
            >
              {expanded ? '▾' : '▸'}
            </button>
          )}
          {children.length === 0 && <span className="w-3.5 shrink-0" />}

          <Badge variant={issue.level === 1 ? 'blue' : issue.level === 2 ? 'purple' : 'gray'} size="sm">
            L{issue.level}
          </Badge>
          <code className="text-xs text-brand-400 font-mono shrink-0">{issue.issue_code}</code>
          <span className="text-sm text-foreground truncate flex-1">{issue.label}</span>
          {!issue.is_active && <Badge variant="gray" size="sm">Inactive</Badge>}
        </div>
        {expanded && children.map((child) => (
          <IssueRow key={child.id} issue={child} depth={depth + 1} />
        ))}
      </div>
    )
  }

  const TABS: { key: Tab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { key: 'tree', label: 'Live Tree', icon: TreeDeciduous },
    { key: 'drafts', label: 'Drafts', icon: GitBranch },
    { key: 'versions', label: 'Versions', icon: History },
  ]

  return (
    <div>
      <PageHeader
        title="Taxonomy Management"
        subtitle="Manage the hierarchical issue classification tree"
        actions={
          <div className="flex items-center gap-2">
            {activeVersion && (
              <VersionBadge version={activeVersion.active_version} isActive />
            )}
            {canPublish && (
              <Button variant="primary" size="sm" onClick={() => setShowPublishDialog(true)}>
                Publish New Version
              </Button>
            )}
          </div>
        }
      />

      {/* Tabs */}
      <div className="flex gap-1 mb-4 border-b border-surface-border">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              'flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors',
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

      {/* Tree Tab */}
      {activeTab === 'tree' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Tree panel */}
          <div className="lg:col-span-2">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle>Issue Taxonomy</CardTitle>
                  <div className="flex items-center gap-3">
                    <Switch
                      checked={includeInactive}
                      onCheckedChange={setIncludeInactive}
                      label="Show Inactive"
                    />
                    {canEdit && (
                      <Button variant="secondary" size="sm" onClick={() => { setAddingNew(true); setSelectedIssue(null) }}>
                        <Plus className="w-3.5 h-3.5" />
                        Add Issue
                      </Button>
                    )}
                    {canPublish && (
                      <Button variant="ghost" size="sm" onClick={() => vectorizeMut.mutate()} loading={vectorizeMut.isPending}>
                        <RefreshCw className="w-3.5 h-3.5" />
                        Vectorize
                      </Button>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                {isLoading ? (
                  <div className="p-4 space-y-2">
                    {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-8" />)}
                  </div>
                ) : !issues?.length ? (
                  <EmptyState title="No taxonomy issues found" />
                ) : (
                  <div className="max-h-[600px] overflow-y-auto py-2">
                    {buildTree(issues).map((issue) => (
                      <IssueRow key={issue.id} issue={issue} />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Edit panel */}
          <div>
            {selectedIssue && !addingNew && (
              <Card>
                <CardHeader>
                  <CardTitle>Issue Detail</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div>
                    <p className="text-xs text-subtle">Code</p>
                    <code className="text-sm font-mono text-brand-400">{selectedIssue.issue_code}</code>
                  </div>
                  <div>
                    <p className="text-xs text-subtle">Label</p>
                    <p className="text-sm text-foreground">{selectedIssue.label}</p>
                  </div>
                  {selectedIssue.description && (
                    <div>
                      <p className="text-xs text-subtle">Description</p>
                      <p className="text-xs text-muted">{selectedIssue.description}</p>
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <p className="text-xs text-subtle">Level</p>
                      <Badge variant="blue">L{selectedIssue.level}</Badge>
                    </div>
                    <div>
                      <p className="text-xs text-subtle">Status</p>
                      <StatusPill status={selectedIssue.is_active ? 'active' : 'inactive'} />
                    </div>
                  </div>
                  <div>
                    <p className="text-xs text-subtle">Updated</p>
                    <p className="text-xs text-muted">{formatDate(selectedIssue.updated_at)}</p>
                  </div>

                  {canEdit && (
                    <div className="pt-2 flex gap-2">
                      {selectedIssue.is_active ? (
                        <Button
                          variant="danger"
                          size="sm"
                          className="flex-1"
                          onClick={() => deactivateMut.mutate(selectedIssue.issue_code)}
                          loading={deactivateMut.isPending}
                        >
                          Deactivate
                        </Button>
                      ) : (
                        <Button
                          variant="secondary"
                          size="sm"
                          className="flex-1"
                          onClick={() => reactivateMut.mutate(selectedIssue.issue_code)}
                          loading={reactivateMut.isPending}
                        >
                          Reactivate
                        </Button>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Add New Issue Form */}
            {addingNew && canEdit && (
              <AddIssueForm
                issues={issues ?? []}
                onClose={() => setAddingNew(false)}
                onSuccess={() => {
                  setAddingNew(false)
                  void qc.invalidateQueries({ queryKey: ['taxonomy'] })
                }}
              />
            )}

            {!selectedIssue && !addingNew && (
              <Card>
                <CardContent>
                  <EmptyState
                    icon={<TreeDeciduous className="w-8 h-8 text-subtle" />}
                    title="Select an issue"
                    description="Click on any node in the taxonomy tree to view details and actions."
                  />
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      )}

      {/* Versions Tab */}
      {activeTab === 'versions' && (
        <Card>
          <CardHeader>
            <CardTitle>Taxonomy Versions</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {!versions?.length ? (
              <EmptyState title="No versions yet" description="Publish your first version to see it here." />
            ) : (
              <div className="divide-y divide-surface-border">
                {versions.map((v) => (
                  <div key={v.version_id} className="flex items-center gap-4 px-4 py-3">
                    <VersionBadge
                      version={v.version_label}
                      isActive={v.version_label === activeVersion?.active_version}
                    />
                    <StatusPill status={v.status} />
                    <span className="text-xs text-subtle">{v.created_by ?? '—'}</span>
                    <span className="text-xs text-subtle">{formatDate(v.created_at)}</span>
                    <div className="ml-auto flex gap-2">
                      <Button
                        variant="ghost" size="xs"
                        onClick={() => setRollbackTarget(v.version_label)}
                        disabled={!canPublish || v.version_label === activeVersion?.active_version}
                      >
                        Rollback
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Drafts Tab */}
      {activeTab === 'drafts' && (
        <DraftsPanel canPublish={canPublish} activeVersion={activeVersion?.active_version} />
      )}

      {/* Publish Dialog */}
      <ConfirmDialog
        open={showPublishDialog}
        onClose={() => setShowPublishDialog(false)}
        onConfirm={() => publishLabel && publishMut.mutate(publishLabel)}
        title="Publish Taxonomy Version"
        description=""
        confirmLabel="Publish"
        loading={publishMut.isPending}
      />

      {/* Custom publish input inside the dialog via DOM is tricky, so inline it */}
      {showPublishDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowPublishDialog(false)} />
          <div className="relative bg-surface-card border border-surface-border rounded-lg p-6 max-w-sm w-full mx-4 shadow-xl">
            <h3 className="text-base font-semibold text-foreground mb-2">Publish Taxonomy Version</h3>
            <p className="text-sm text-muted mb-4">Enter a version label for this snapshot.</p>
            <Input
              placeholder="e.g. v2.1.0"
              value={publishLabel}
              onChange={(e) => setPublishLabel(e.target.value)}
              className="mb-4"
            />
            <div className="flex gap-3 justify-end">
              <Button variant="ghost" onClick={() => setShowPublishDialog(false)}>Cancel</Button>
              <Button
                variant="primary"
                onClick={() => publishLabel && publishMut.mutate(publishLabel)}
                loading={publishMut.isPending}
                disabled={!publishLabel.trim()}
              >
                Publish
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Rollback confirmation */}
      <ConfirmDialog
        open={rollbackTarget != null}
        onClose={() => setRollbackTarget(null)}
        onConfirm={() => rollbackTarget && rollbackMut.mutate(rollbackTarget)}
        title={`Rollback to ${rollbackTarget}?`}
        description={`This will revert the live taxonomy to version ${rollbackTarget}. This action cannot be undone easily.`}
        confirmLabel="Rollback"
        loading={rollbackMut.isPending}
      />
    </div>
  )
}

function AddIssueForm({
  issues, onClose, onSuccess,
}: { issues: TaxonomyIssue[]; onClose: () => void; onSuccess: () => void }) {
  const [code, setCode] = useState('')
  const [label, setLabel] = useState('')
  const [description, setDescription] = useState('')
  const [parentId, setParentId] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)

  const level = parentId
    ? (issues.find((i) => i.id === parentId)?.level ?? 0) + 1
    : 1

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    try {
      await taxonomyApi.add({ issue_code: code, label, description: description || undefined, parent_id: parentId, level })
      toast.success('Issue added')
      onSuccess()
    } catch {
      toast.error('Failed to add issue')
    } finally {
      setLoading(false)
    }
  }

  const l1Issues = issues.filter((i) => i.level === 1)
  const l2Issues = issues.filter((i) => i.level === 2)

  return (
    <Card>
      <CardHeader><CardTitle>Add New Issue</CardTitle></CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="text-xs text-muted">Parent Issue (optional)</label>
            <select
              className="w-full bg-surface border border-surface-border rounded-md px-3 py-2 text-sm text-foreground mt-1 focus:outline-none focus:ring-1 focus:ring-brand-500"
              value={parentId ?? ''}
              onChange={(e) => setParentId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">None (Level 1)</option>
              <optgroup label="Level 1">
                {l1Issues.map((i) => <option key={i.id} value={i.id}>{i.label} ({i.issue_code})</option>)}
              </optgroup>
              <optgroup label="Level 2">
                {l2Issues.map((i) => <option key={i.id} value={i.id}>{i.label} ({i.issue_code})</option>)}
              </optgroup>
            </select>
          </div>
          <div className="flex items-center gap-1 text-xs text-subtle">
            Level: <Badge variant="blue">L{level}</Badge>
          </div>
          <Input label="Issue Code *" placeholder="DELIVERY_MISSING" value={code} onChange={(e) => setCode(e.target.value)} required />
          <Input label="Label *" placeholder="Missing Delivery" value={label} onChange={(e) => setLabel(e.target.value)} required />
          <Textarea label="Description" placeholder="Optional description" value={description} onChange={(e) => setDescription(e.target.value)} className="min-h-[60px]" />
          <div className="flex gap-2 pt-1">
            <Button variant="ghost" size="sm" onClick={onClose} type="button">Cancel</Button>
            <Button variant="primary" size="sm" type="submit" loading={loading} className="flex-1">Add Issue</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

function DraftsPanel({ canPublish, activeVersion }: { canPublish: boolean; activeVersion?: string }) {
  const { data: drafts, isLoading } = useQuery({
    queryKey: ['taxonomy', 'drafts'],
    queryFn: () => taxonomyApi.getDrafts().then((r) => r.data),
  })

  if (isLoading) return <Skeleton className="h-40" />

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Pending Drafts</CardTitle>
          {activeVersion && <VersionBadge version={activeVersion} isActive />}
        </div>
      </CardHeader>
      <CardContent>
        {!drafts?.length ? (
          <EmptyState title="No drafts" description="Save an issue as draft to see it here." />
        ) : (
          <div className="space-y-2">
            {drafts.map((d) => (
              <div key={d.id} className="flex items-center gap-3 p-3 bg-surface rounded-md border border-surface-border">
                <code className="text-xs font-mono text-brand-400">{d.issue_code}</code>
                <span className="text-sm text-foreground flex-1">{d.label}</span>
                <Badge variant="amber">Draft</Badge>
              </div>
            ))}
            {canPublish && (
              <p className="text-xs text-subtle pt-2">
                Use the "Publish New Version" button in the header to publish all drafts as a new version.
              </p>
            )}
          </div>
        )}
        {!canPublish && (
          <p className="text-xs text-subtle mt-2">Publisher role required to publish drafts.</p>
        )}
        <div className="mt-4 p-3 bg-surface rounded-md">
          <p className="text-xs text-muted font-medium">Audit Logs</p>
          <p className="text-xs text-subtle">Go to System Admin → Audit Logs to see taxonomy change history.</p>
        </div>
      </CardContent>
    </Card>
  )
}

