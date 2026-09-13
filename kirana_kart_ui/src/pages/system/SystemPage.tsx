import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { StatusPill } from '@/components/common/StatusPill'
import { EmptyState } from '@/components/common/EmptyState'
import { Skeleton } from '@/components/ui/Skeleton'
import { Input } from '@/components/ui/Input'
import { governanceSystemApi } from '@/api/governance/system.api'
import { ingestHealthApi } from '@/api/ingest/health.api'
import { vectorizationApi } from '@/api/governance/vectorization.api'
import { toast } from '@/stores/toast.store'
import { useAuthStore } from '@/stores/auth.store'
import { formatDate } from '@/lib/dates'
import { cn } from '@/lib/cn'
import { Activity, Server, Settings, FileText, Cpu, Plug } from 'lucide-react'
import { IntegrationsPanel } from './IntegrationsPanel'

type Tab = 'health' | 'vector-jobs' | 'audit-logs' | 'models' | 'integrations'

export default function SystemPage() {
  const [activeTab, setActiveTab] = useState<Tab>('health')
  const { user } = useAuthStore()

  const TABS: { key: Tab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { key: 'health', label: 'System Health', icon: Activity },
    { key: 'vector-jobs', label: 'Vector Jobs', icon: Cpu },
    { key: 'audit-logs', label: 'Audit Logs', icon: FileText },
    { key: 'models', label: 'Model Registry', icon: Settings },
    { key: 'integrations', label: 'Integrations', icon: Plug },
  ]

  return (
    <div>
      <PageHeader title="System Admin" subtitle="Monitor system health, vector jobs, audit logs, and model registry" />

      <div className="flex gap-1 mb-4 border-b border-surface-border">
        {TABS.map((tab) => (
          <button key={tab.key} onClick={() => setActiveTab(tab.key)}
            className={cn('flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors',
              activeTab === tab.key ? 'border-brand-500 text-brand-400' : 'border-transparent text-muted hover:text-foreground')}>
            <tab.icon className="w-3.5 h-3.5" />{tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'health' && <SystemHealthPanel />}
      {activeTab === 'vector-jobs' && <VectorJobsPanel canPublish={user?.is_super_admin === true} />}
      {activeTab === 'audit-logs' && <AuditLogsPanel />}
      {activeTab === 'models' && <ModelRegistryPanel />}
      {activeTab === 'integrations' && <IntegrationsPanel />}
    </div>
  )
}

function SystemHealthPanel() {
  const { data: govStatus, isLoading: govLoading } = useQuery({
    queryKey: ['system', 'status', 'governance'],
    queryFn: () => governanceSystemApi.systemStatus().then((r) => r.data),
    refetchInterval: 30_000,
    retry: false,
  })

  const { data: ingestStatus, isLoading: ingestLoading } = useQuery({
    queryKey: ['system', 'status', 'ingest'],
    queryFn: () => ingestHealthApi.systemStatus().then((r) => r.data),
    refetchInterval: 30_000,
    retry: false,
  })

  const { data: workerHealth, isLoading: workerLoading } = useQuery({
    queryKey: ['system', 'worker'],
    queryFn: () => governanceSystemApi.workerHealth().then((r) => r.data),
    refetchInterval: 30_000,
    retry: false,
  })

  const serviceCards = [
    {
      label: 'Governance Plane (8001)',
      icon: Server,
      loading: govLoading,
      data: govStatus,
      status: govStatus?.status,
      details: govStatus ? [
        { label: 'Database', value: govStatus.database },
        { label: 'Redis', value: govStatus.redis },
        { label: 'Weaviate', value: govStatus.weaviate },
        { label: 'Active Version', value: govStatus.active_version },
        { label: 'Shadow Version', value: govStatus.shadow_version ?? 'None' },
      ] : [],
    },
    {
      label: 'Ingest Plane (8000)',
      icon: Activity,
      loading: ingestLoading,
      data: ingestStatus,
      status: ingestStatus?.status,
      details: ingestStatus ? [
        { label: 'Database', value: ingestStatus.database },
        { label: 'Redis', value: ingestStatus.redis },
      ] : [],
    },
  ]

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {serviceCards.map((sc) => (
          <Card key={sc.label}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <sc.icon className="w-4 h-4 text-muted" />
                  <CardTitle>{sc.label}</CardTitle>
                </div>
                {sc.loading ? <Skeleton className="w-16 h-5" /> : sc.status && <StatusPill status={sc.status} />}
              </div>
            </CardHeader>
            <CardContent>
              {sc.loading ? (
                <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-4" />)}</div>
              ) : sc.details.length === 0 ? (
                <p className="text-xs text-subtle">Service unreachable</p>
              ) : (
                <div className="grid grid-cols-2 gap-2 text-xs">
                  {sc.details.map((d) => (
                    <div key={d.label}>
                      <span className="text-subtle">{d.label}</span>
                      <p className="text-foreground mt-0.5">{String(d.value ?? '—')}</p>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Vector Worker */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Cpu className="w-4 h-4 text-muted" />
              <CardTitle>Vector Background Worker</CardTitle>
            </div>
            {workerLoading ? <Skeleton className="w-16 h-5" /> : (
              <StatusPill status={workerHealth?.status === 'alive' ? 'healthy' : 'unhealthy'} />
            )}
          </div>
        </CardHeader>
        <CardContent>
          {workerLoading ? <Skeleton className="h-12" /> : !workerHealth ? (
            <p className="text-xs text-subtle">Worker status unavailable</p>
          ) : (
            <div className="grid grid-cols-3 gap-4 text-xs">
              <div><span className="text-subtle">Status</span><p className="text-foreground">{workerHealth.status}</p></div>
              <div><span className="text-subtle">Last Heartbeat</span><p className="text-foreground">{workerHealth.last_heartbeat_s != null ? `${workerHealth.last_heartbeat_s}s ago` : '—'}</p></div>
              <div><span className="text-subtle">Jobs Processed</span><p className="text-foreground">{workerHealth.jobs_processed?.toLocaleString() ?? '—'}</p></div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function VectorJobsPanel({ canPublish }: { canPublish: boolean }) {
  const [versionInput, setVersionInput] = useState('')

  const { data: jobs, isLoading, refetch } = useQuery({
    queryKey: ['system', 'vector-jobs'],
    queryFn: () => governanceSystemApi.getVectorJobs().then((r) => r.data),
    refetchInterval: (q) => {
      const d = q.state.data as Array<{ status: string }> | undefined
      if (d?.some((j) => j.status === 'pending' || j.status === 'running')) return 10_000
      return false
    },
  })

  const runMut = useMutation({
    mutationFn: () => vectorizationApi.runPending(),
    onSuccess: () => { toast.success('Pending jobs started'); void refetch() },
    onError: () => toast.error('Failed to run jobs'),
  })

  const vectorizeMut = useMutation({
    mutationFn: (v: string) => vectorizationApi.vectorizeVersion(v),
    onSuccess: (_, v) => { toast.success('Vectorization queued', `Version ${v}`); void refetch() },
    onError: () => toast.error('Vectorization failed'),
  })

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        {canPublish && (
          <Button variant="secondary" size="sm" onClick={() => runMut.mutate()} loading={runMut.isPending}>
            <Cpu className="w-4 h-4" />Run Pending Jobs
          </Button>
        )}
        {canPublish && (
          <div className="flex gap-2">
            <Input placeholder="Version label" value={versionInput} onChange={(e) => setVersionInput(e.target.value)} />
            <Button variant="secondary" size="sm" onClick={() => vectorizeMut.mutate(versionInput)} disabled={!versionInput} loading={vectorizeMut.isPending}>
              Force Vectorize
            </Button>
          </div>
        )}
      </div>

      <Card>
        <CardHeader><CardTitle>Vector Job Queue</CardTitle></CardHeader>
        <CardContent className="p-0">
          {isLoading ? <div className="p-4"><Skeleton className="h-40" /></div> : !jobs?.length ? (
            <EmptyState title="No vector jobs" description="Vector jobs appear when documents are queued for embedding." />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-border">
                  {['ID', 'Version', 'Status', 'Created', 'Started', 'Completed', 'Error'].map((h) => (
                    <th key={h} className="px-4 py-2.5 text-left text-xs font-medium text-subtle">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {jobs.map((j) => (
                  <tr key={j.id} className="hover:bg-surface-card/50">
                    <td className="px-4 py-3 text-xs font-mono text-muted">{j.id}</td>
                    <td className="px-4 py-3 font-mono text-brand-400 text-xs">{j.version_label}</td>
                    <td className="px-4 py-3"><StatusPill status={j.status} /></td>
                    <td className="px-4 py-3 text-xs text-subtle">{formatDate(j.created_at)}</td>
                    <td className="px-4 py-3 text-xs text-subtle">{formatDate(j.started_at)}</td>
                    <td className="px-4 py-3 text-xs text-subtle">{formatDate(j.completed_at)}</td>
                    <td className="px-4 py-3 text-xs text-red-400 max-w-xs truncate">{j.error ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function AuditLogsPanel() {
  const { data: logs, isLoading } = useQuery({
    queryKey: ['system', 'audit-logs'],
    queryFn: () => governanceSystemApi.getAuditLogs({ limit: 100 }).then((r) => r.data),
  })

  const { data: taxonomyLogs } = useQuery({
    queryKey: ['taxonomy', 'audit'],
    queryFn: () => import('@/api/governance/taxonomy.api').then((m) => m.taxonomyApi.getAudit(100)).then((r) => r.data),
  })

  return (
    <div className="space-y-4">
      {taxonomyLogs && taxonomyLogs.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Taxonomy Audit Log</CardTitle></CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-border">
                  {['Action', 'Issue Code', 'Changed By', 'Changed At'].map((h) => (
                    <th key={h} className="px-4 py-2.5 text-left text-xs font-medium text-subtle">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {taxonomyLogs.map((l) => (
                  <tr key={l.id} className="hover:bg-surface-card/50">
                    <td className="px-4 py-3"><Badge variant="blue">{l.action_type}</Badge></td>
                    <td className="px-4 py-3 font-mono text-xs text-brand-400">{l.issue_code}</td>
                    <td className="px-4 py-3 text-xs text-muted">{l.changed_by}</td>
                    <td className="px-4 py-3 text-xs text-subtle">{formatDate(l.changed_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle>Execution Audit Log</CardTitle></CardHeader>
        <CardContent className="p-0">
          {isLoading ? <div className="p-4"><Skeleton className="h-40" /></div> : !logs?.length ? (
            <EmptyState title="No audit logs" description="Execution audit logs will appear when the endpoint is available." />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-border">
                  {['Event Type', 'Stage', 'Ticket', 'Message', 'Time'].map((h) => (
                    <th key={h} className="px-4 py-2.5 text-left text-xs font-medium text-subtle">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {logs.map((l) => (
                  <tr key={l.id} className="hover:bg-surface-card/50">
                    <td className="px-4 py-3"><Badge variant="blue">{l.event_type}</Badge></td>
                    <td className="px-4 py-3 text-xs text-muted">{l.stage_name ?? '—'}</td>
                    <td className="px-4 py-3 font-mono text-xs text-brand-400">{l.ticket_id ?? '—'}</td>
                    <td className="px-4 py-3 text-xs text-foreground max-w-xs truncate">{l.message}</td>
                    <td className="px-4 py-3 text-xs text-subtle">{formatDate(l.event_time)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function ModelRegistryPanel() {
  const { data: models, isLoading } = useQuery({
    queryKey: ['system', 'models'],
    queryFn: () => governanceSystemApi.getModelRegistry().then((r) => r.data),
  })

  return (
    <Card>
      <CardHeader><CardTitle>Model Registry</CardTitle></CardHeader>
      <CardContent className="p-0">
        {isLoading ? <div className="p-4"><Skeleton className="h-40" /></div> : !models?.length ? (
          <EmptyState title="No models" description="Model registry will appear when the endpoint is available." />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-border">
                {['Model Name', 'Version', 'Deployed At', 'Status'].map((h) => (
                  <th key={h} className="px-4 py-2.5 text-left text-xs font-medium text-subtle">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border">
              {models.map((m) => (
                <tr key={`${m.model_name}-${m.model_version}`} className="hover:bg-surface-card/50">
                  <td className="px-4 py-3 font-mono text-xs text-brand-400">{m.model_name}</td>
                  <td className="px-4 py-3 font-mono text-xs text-foreground">{m.model_version}</td>
                  <td className="px-4 py-3 text-xs text-subtle">{formatDate(m.deployed_at)}</td>
                  <td className="px-4 py-3"><Badge variant={m.is_active ? 'green' : 'gray'}>{m.is_active ? 'Active' : 'Inactive'}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  )
}
