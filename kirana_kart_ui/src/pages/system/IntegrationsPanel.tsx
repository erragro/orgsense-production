/**
 * src/pages/system/IntegrationsPanel.tsx
 * =========================================
 * Channel Integrations management UI.
 *
 * Features:
 *  - Type summary cards (Gmail · Outlook · SMTP/IMAP · API)
 *  - Full integration list table with toggle / edit / delete / sync
 *  - Add / Edit modal with type-specific config fields
 *  - API key generation flow (shows key once, copy-protected)
 *  - Test Connection inline feedback
 */

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Badge } from '@/components/ui/Badge'
import { Switch } from '@/components/ui/Switch'
import { Skeleton } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/common/EmptyState'
import { CopyButton } from '@/components/common/CopyButton'
import { toast } from '@/stores/toast.store'
import { integrationsApi } from '@/api/governance/integrations.api'
import { formatDate } from '@/lib/dates'
import { cn } from '@/lib/cn'
import type {
  Integration,
  IntegrationType,
  CreateIntegrationPayload,
} from '@/types/integration.types'
import {
  Mail,
  RefreshCw,
  Trash2,
  Settings2,
  Plus,
  X,
  Plug,
  Key,
  AlertCircle,
  CheckCircle2,
  Loader2,
} from 'lucide-react'

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────

const TYPE_META: Record<IntegrationType, { label: string; color: string; icon: React.ComponentType<{ className?: string }> }> = {
  gmail:   { label: 'Gmail',       color: 'bg-red-500/10 text-red-400 border-red-500/20',    icon: Mail },
  outlook: { label: 'Outlook',     color: 'bg-blue-500/10 text-blue-400 border-blue-500/20',  icon: Mail },
  smtp:    { label: 'SMTP / IMAP', color: 'bg-amber-500/10 text-amber-400 border-amber-500/20', icon: Mail },
  api:     { label: 'API Key',     color: 'bg-purple-500/10 text-purple-400 border-purple-500/20', icon: Key },
}

const INTEGRATION_TYPES: IntegrationType[] = ['gmail', 'outlook', 'smtp', 'api']

const BUSINESS_LINES = ['ecommerce', 'saas', 'fintech', 'healthcare', 'retail', 'other']
const MODULES = ['delivery', 'payments', 'returns', 'support', 'billing', 'onboarding', 'other']
const ORGS = ['default', 'testorg', 'prodorg']

// ─────────────────────────────────────────────────────────────
// HELPER — blank config per type
// ─────────────────────────────────────────────────────────────

function blankConfig(type: IntegrationType): Record<string, unknown> {
  switch (type) {
    case 'gmail':
      return {
        email_address: '',
        client_id: '',
        client_secret: '',
        access_token: '',
        refresh_token: '',
        poll_interval_minutes: 5,
        label_filter: 'INBOX',
        mark_as_read: true,
      }
    case 'outlook':
      return {
        email_address: '',
        tenant_id: '',
        client_id: '',
        client_secret: '',
        poll_interval_minutes: 5,
        folder: 'Inbox',
        mark_as_read: true,
      }
    case 'smtp':
      return {
        email_address: '',
        imap_host: '',
        imap_port: 993,
        username: '',
        password: '',
        use_ssl: true,
        poll_interval_minutes: 10,
        folder: 'INBOX',
        mark_as_read: true,
      }
    case 'api':
      return {
        description: '',
        ingest_url: 'http://your-server:8000/cardinal/ingest',
      }
  }
}

// ─────────────────────────────────────────────────────────────
// SYNC STATUS PILL
// ─────────────────────────────────────────────────────────────

function SyncStatusPill({ status, error }: { status: string; error?: string | null }) {
  const map: Record<string, string> = {
    idle:    'text-muted border-surface-border bg-surface-card',
    running: 'text-amber-400 border-amber-500/30 bg-amber-500/10',
    ok:      'text-green-400 border-green-500/30 bg-green-500/10',
    error:   'text-red-400 border-red-500/30 bg-red-500/10',
  }
  return (
    <span
      title={error ?? undefined}
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full border',
        map[status] ?? map.idle,
      )}
    >
      {status === 'running' && <Loader2 className="w-3 h-3 animate-spin" />}
      {status === 'error'   && <AlertCircle className="w-3 h-3" />}
      {status === 'ok'      && <CheckCircle2 className="w-3 h-3" />}
      {status}
    </span>
  )
}

// ─────────────────────────────────────────────────────────────
// TYPE SUMMARY CARD
// ─────────────────────────────────────────────────────────────

function TypeCard({
  type,
  integrations,
  onAdd,
}: {
  type: IntegrationType
  integrations: Integration[]
  onAdd: (type: IntegrationType) => void
}) {
  const meta = TYPE_META[type]
  const Icon = meta.icon
  const items = integrations.filter((i) => i.type === type)
  const active = items.filter((i) => i.is_active).length

  return (
    <Card
      className="cursor-pointer hover:border-brand-500/40 transition-colors"
      onClick={() => onAdd(type)}
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div className={cn('w-8 h-8 rounded-lg border flex items-center justify-center flex-shrink-0', meta.color)}>
            <Icon className="w-4 h-4" />
          </div>
          <Plus className="w-4 h-4 text-muted mt-1 flex-shrink-0" />
        </div>
        <p className="mt-2 text-sm font-medium text-foreground">{meta.label}</p>
        <p className="text-xs text-subtle mt-0.5">
          {items.length === 0
            ? 'No integrations'
            : `${active} active · ${items.length} total`}
        </p>
      </CardContent>
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────
// CONFIG FORM — TYPE SPECIFIC FIELDS
// ─────────────────────────────────────────────────────────────

function ConfigFields({
  type,
  config,
  onChange,
  isEdit,
}: {
  type: IntegrationType
  config: Record<string, unknown>
  onChange: (key: string, value: unknown) => void
  isEdit: boolean
}) {
  const str = (k: string) => (config[k] as string) ?? ''
  const num = (k: string, def: number) => (config[k] as number) ?? def
  const bool = (k: string, def: boolean) => (config[k] as boolean) ?? def

  if (type === 'gmail') {
    return (
      <div className="space-y-3">
        <Field label="Email Address">
          <Input value={str('email_address')} onChange={(e) => onChange('email_address', e.target.value)} placeholder="you@gmail.com" />
        </Field>
        <Field label="Client ID">
          <Input value={str('client_id')} onChange={(e) => onChange('client_id', e.target.value)} placeholder="OAuth2 client ID" />
        </Field>
        <Field label="Client Secret">
          <Input type="password" value={str('client_secret')} onChange={(e) => onChange('client_secret', e.target.value)} placeholder={isEdit ? '(unchanged)' : 'OAuth2 client secret'} />
        </Field>
        <Field label="Access Token">
          <Input type="password" value={str('access_token')} onChange={(e) => onChange('access_token', e.target.value)} placeholder={isEdit ? '(unchanged)' : 'OAuth2 access token'} />
        </Field>
        <Field label="Refresh Token">
          <Input type="password" value={str('refresh_token')} onChange={(e) => onChange('refresh_token', e.target.value)} placeholder={isEdit ? '(unchanged)' : 'OAuth2 refresh token'} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Label / Folder">
            <Input value={str('label_filter')} onChange={(e) => onChange('label_filter', e.target.value)} placeholder="INBOX" />
          </Field>
          <Field label="Poll Interval (min)">
            <Input type="number" min={1} max={1440} value={num('poll_interval_minutes', 5)} onChange={(e) => onChange('poll_interval_minutes', Number(e.target.value))} />
          </Field>
        </div>
        <Switch
          checked={bool('mark_as_read', true)}
          onCheckedChange={(v) => onChange('mark_as_read', v)}
          label="Mark emails as read after processing"
        />
      </div>
    )
  }

  if (type === 'outlook') {
    return (
      <div className="space-y-3">
        <Field label="Email Address">
          <Input value={str('email_address')} onChange={(e) => onChange('email_address', e.target.value)} placeholder="you@company.onmicrosoft.com" />
        </Field>
        <Field label="Tenant ID">
          <Input value={str('tenant_id')} onChange={(e) => onChange('tenant_id', e.target.value)} placeholder="Azure tenant ID (UUID)" />
        </Field>
        <Field label="Client ID">
          <Input value={str('client_id')} onChange={(e) => onChange('client_id', e.target.value)} placeholder="App registration client ID" />
        </Field>
        <Field label="Client Secret">
          <Input type="password" value={str('client_secret')} onChange={(e) => onChange('client_secret', e.target.value)} placeholder={isEdit ? '(unchanged)' : 'App client secret'} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Folder">
            <Input value={str('folder')} onChange={(e) => onChange('folder', e.target.value)} placeholder="Inbox" />
          </Field>
          <Field label="Poll Interval (min)">
            <Input type="number" min={1} max={1440} value={num('poll_interval_minutes', 5)} onChange={(e) => onChange('poll_interval_minutes', Number(e.target.value))} />
          </Field>
        </div>
        <Switch
          checked={bool('mark_as_read', true)}
          onCheckedChange={(v) => onChange('mark_as_read', v)}
          label="Mark emails as read after processing"
        />
      </div>
    )
  }

  if (type === 'smtp') {
    return (
      <div className="space-y-3">
        <Field label="Email Address">
          <Input value={str('email_address')} onChange={(e) => onChange('email_address', e.target.value)} placeholder="support@company.com" />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="IMAP Host" className="col-span-2">
            <Input value={str('imap_host')} onChange={(e) => onChange('imap_host', e.target.value)} placeholder="imap.gmail.com" />
          </Field>
          <Field label="Port">
            <Input type="number" value={num('imap_port', 993)} onChange={(e) => onChange('imap_port', Number(e.target.value))} />
          </Field>
        </div>
        <Field label="Username">
          <Input value={str('username')} onChange={(e) => onChange('username', e.target.value)} placeholder="IMAP username (usually email)" />
        </Field>
        <Field label="Password">
          <Input type="password" value={str('password')} onChange={(e) => onChange('password', e.target.value)} placeholder={isEdit ? '(unchanged)' : 'IMAP password or app password'} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Folder">
            <Input value={str('folder')} onChange={(e) => onChange('folder', e.target.value)} placeholder="INBOX" />
          </Field>
          <Field label="Poll Interval (min)">
            <Input type="number" min={1} max={1440} value={num('poll_interval_minutes', 10)} onChange={(e) => onChange('poll_interval_minutes', Number(e.target.value))} />
          </Field>
        </div>
        <div className="flex gap-6">
          <Switch
            checked={bool('use_ssl', true)}
            onCheckedChange={(v) => onChange('use_ssl', v)}
            label="Use SSL"
          />
          <Switch
            checked={bool('mark_as_read', true)}
            onCheckedChange={(v) => onChange('mark_as_read', v)}
            label="Mark as read after processing"
          />
        </div>
      </div>
    )
  }

  if (type === 'api') {
    return (
      <div className="space-y-3">
        <Field label="Description">
          <Input value={str('description')} onChange={(e) => onChange('description', e.target.value)} placeholder="What system will use this key?" />
        </Field>
        <div className="rounded-lg bg-surface-card border border-surface-border p-3 text-xs space-y-1">
          <p className="text-subtle font-medium">Ingest Endpoint</p>
          <div className="flex items-center gap-2 font-mono text-brand-400 break-all">
            <span className="flex-1">{str('ingest_url') || 'http://your-server:8000/cardinal/ingest'}</span>
            <CopyButton text={(str('ingest_url') || 'http://your-server:8000/cardinal/ingest')} />
          </div>
          <p className="text-subtle mt-2">
            An API key will be generated automatically on save and shown <strong className="text-foreground">once</strong>.
          </p>
        </div>
      </div>
    )
  }

  return null
}

function Field({
  label,
  children,
  className,
}: {
  label: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={className}>
      <label className="block text-xs font-medium text-muted mb-1">{label}</label>
      {children}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// ADD / EDIT MODAL
// ─────────────────────────────────────────────────────────────

interface ModalProps {
  mode: 'add' | 'edit'
  defaultType?: IntegrationType
  integration?: Integration
  onClose: () => void
  onSaved: () => void
}

function IntegrationModal({ mode, defaultType, integration, onClose, onSaved }: ModalProps) {
  const isEdit = mode === 'edit'
  const [name, setName] = useState(integration?.name ?? '')
  const [type, setType] = useState<IntegrationType>(defaultType ?? integration?.type ?? 'gmail')
  const [org, setOrg] = useState(integration?.org ?? 'default')
  const [businessLine, setBusinessLine] = useState(integration?.business_line ?? 'ecommerce')
  const [module, setModule] = useState(integration?.module ?? 'delivery')
  const [config, setConfig] = useState<Record<string, unknown>>(
    isEdit ? (integration?.config ?? {}) : blankConfig(type),
  )
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)
  const [testing, setTesting] = useState(false)
  // For new API integrations — show key once after save
  const [generatedKey, setGeneratedKey] = useState<string | null>(null)

  const qc = useQueryClient()

  const handleTypeChange = (t: IntegrationType) => {
    setType(t)
    if (!isEdit) setConfig(blankConfig(t))
  }

  const handleConfigChange = (key: string, value: unknown) => {
    setConfig((prev) => ({ ...prev, [key]: value }))
  }

  // Create mutation
  const createMut = useMutation({
    mutationFn: (payload: CreateIntegrationPayload) => integrationsApi.create(payload),
    onSuccess: (res) => {
      const data = res.data
      // Show the generated API key if present
      const key = (data.config as Record<string, unknown>)?.api_key as string | undefined
      if (key && key.startsWith('kk_live_')) {
        setGeneratedKey(key)
      } else {
        toast.success('Integration created')
        onSaved()
      }
      qc.invalidateQueries({ queryKey: ['integrations'] })
    },
    onError: () => toast.error('Failed to create integration'),
  })

  // Update mutation
  const updateMut = useMutation({
    mutationFn: () =>
      integrationsApi.update(integration!.id, {
        name,
        org,
        business_line: businessLine,
        module,
        config,
      }),
    onSuccess: () => {
      toast.success('Integration updated')
      qc.invalidateQueries({ queryKey: ['integrations'] })
      onSaved()
    },
    onError: () => toast.error('Failed to update integration'),
  })

  // Test connection (on existing integration during edit)
  const handleTest = async () => {
    if (!isEdit || !integration) return
    setTesting(true)
    setTestResult(null)
    try {
      const res = await integrationsApi.test(integration.id)
      setTestResult(res.data)
    } catch {
      setTestResult({ success: false, message: 'Test request failed' })
    } finally {
      setTesting(false)
    }
  }

  const handleSave = () => {
    if (!name.trim()) {
      toast.error('Name is required')
      return
    }
    if (isEdit) {
      updateMut.mutate()
    } else {
      createMut.mutate({
        name: name.trim(),
        type,
        org,
        business_line: businessLine,
        module,
        config,
      })
    }
  }

  const isBusy = createMut.isPending || updateMut.isPending

  // ── After API key generated: show once screen ──
  if (generatedKey) {
    return (
      <Overlay onClose={onClose}>
        <div className="bg-surface-card border border-surface-border rounded-xl p-6 w-full max-w-lg space-y-4">
          <div className="flex items-center gap-2">
            <Key className="w-5 h-5 text-brand-400" />
            <h2 className="text-base font-semibold text-foreground">API Key Generated</h2>
          </div>
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 text-xs text-amber-300">
            ⚠ Copy this key now — it will <strong>not</strong> be shown again.
          </div>
          <div className="flex items-center gap-2 bg-surface-bg rounded-lg border border-surface-border p-3">
            <code className="flex-1 text-xs font-mono text-brand-300 break-all">{generatedKey}</code>
            <CopyButton text={generatedKey} />
          </div>
          <p className="text-xs text-subtle">
            Use this key as an <code className="text-brand-300">Authorization: Bearer &lt;key&gt;</code> header
            when calling the Cardinal ingest endpoint.
          </p>
          <Button onClick={onClose} className="w-full">Done</Button>
        </div>
      </Overlay>
    )
  }

  return (
    <Overlay onClose={onClose}>
      <div className="bg-surface-card border border-surface-border rounded-xl w-full max-w-2xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-surface-border flex-shrink-0">
          <div className="flex items-center gap-2">
            <Plug className="w-4 h-4 text-brand-400" />
            <h2 className="text-base font-semibold text-foreground">
              {isEdit ? `Edit Integration` : 'Add Integration'}
            </h2>
          </div>
          <button onClick={onClose} className="text-muted hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 p-5 space-y-5">
          {/* Type selector (only on create) */}
          {!isEdit && (
            <div>
              <label className="block text-xs font-medium text-muted mb-2">Integration Type</label>
              <div className="grid grid-cols-4 gap-2">
                {INTEGRATION_TYPES.map((t) => {
                  const meta = TYPE_META[t]
                  return (
                    <button
                      key={t}
                      onClick={() => handleTypeChange(t)}
                      className={cn(
                        'px-3 py-2 text-xs rounded-lg border transition-colors text-center',
                        type === t
                          ? 'border-brand-500 bg-brand-500/10 text-brand-300'
                          : 'border-surface-border text-muted hover:border-brand-500/40',
                      )}
                    >
                      {meta.label}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Common fields */}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Integration Name" className="col-span-2">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Support Gmail Inbox"
              />
            </Field>
            <Field label="Org">
              <select
                value={org}
                onChange={(e) => setOrg(e.target.value)}
                className="w-full h-9 rounded-lg border border-surface-border bg-surface-bg px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-brand-500"
              >
                {ORGS.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </Field>
            <Field label="Business Line">
              <select
                value={businessLine}
                onChange={(e) => setBusinessLine(e.target.value)}
                className="w-full h-9 rounded-lg border border-surface-border bg-surface-bg px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-brand-500"
              >
                {BUSINESS_LINES.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </Field>
            <Field label="Module" className="col-span-2">
              <select
                value={module}
                onChange={(e) => setModule(e.target.value)}
                className="w-full h-9 rounded-lg border border-surface-border bg-surface-bg px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-brand-500"
              >
                {MODULES.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </Field>
          </div>

          {/* Separator */}
          <div className="border-t border-surface-border" />

          {/* Type-specific config */}
          <div>
            <p className="text-xs font-medium text-muted mb-3">
              {TYPE_META[isEdit ? (integration?.type ?? type) : type].label} Configuration
            </p>
            <ConfigFields
              type={isEdit ? (integration?.type ?? type) : type}
              config={config}
              onChange={handleConfigChange}
              isEdit={isEdit}
            />
          </div>

          {/* Test result */}
          {testResult && (
            <div
              className={cn(
                'rounded-lg border p-3 text-xs flex items-start gap-2',
                testResult.success
                  ? 'bg-green-500/10 border-green-500/30 text-green-300'
                  : 'bg-red-500/10 border-red-500/30 text-red-300',
              )}
            >
              {testResult.success
                ? <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" />
                : <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />}
              <span>{testResult.message}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-t border-surface-border flex-shrink-0">
          <div>
            {isEdit && (
              <Button
                variant="secondary"
                size="sm"
                onClick={handleTest}
                loading={testing}
                disabled={isBusy}
              >
                Test Connection
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={isBusy}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSave} loading={isBusy}>
              {isEdit ? 'Save Changes' : 'Create Integration'}
            </Button>
          </div>
        </div>
      </div>
    </Overlay>
  )
}

// ─────────────────────────────────────────────────────────────
// OVERLAY wrapper
// ─────────────────────────────────────────────────────────────

function Overlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      {children}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// DELETE CONFIRM
// ─────────────────────────────────────────────────────────────

function DeleteConfirm({
  integration,
  onClose,
  onDeleted,
}: {
  integration: Integration
  onClose: () => void
  onDeleted: () => void
}) {
  const qc = useQueryClient()
  const deleteMut = useMutation({
    mutationFn: () => integrationsApi.delete(integration.id),
    onSuccess: () => {
      toast.success('Integration deleted')
      qc.invalidateQueries({ queryKey: ['integrations'] })
      onDeleted()
    },
    onError: () => toast.error('Failed to delete integration'),
  })

  return (
    <Overlay onClose={onClose}>
      <div className="bg-surface-card border border-surface-border rounded-xl p-6 w-full max-w-md space-y-4">
        <h2 className="text-base font-semibold text-foreground">Delete Integration</h2>
        <p className="text-sm text-subtle">
          Are you sure you want to delete <strong className="text-foreground">{integration.name}</strong>?
          {integration.type === 'api' && (
            <span className="block mt-1 text-red-400">
              This will also revoke the associated API key — any systems using it will lose access immediately.
            </span>
          )}
        </p>
        <div className="flex gap-3 justify-end">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button
            size="sm"
            className="bg-red-600 hover:bg-red-700 text-white"
            onClick={() => deleteMut.mutate()}
            loading={deleteMut.isPending}
          >
            Delete
          </Button>
        </div>
      </div>
    </Overlay>
  )
}

// ─────────────────────────────────────────────────────────────
// MAIN PANEL
// ─────────────────────────────────────────────────────────────

export function IntegrationsPanel() {
  const qc = useQueryClient()

  const { data: integrations, isLoading } = useQuery({
    queryKey: ['integrations'],
    queryFn: () => integrationsApi.list().then((r) => r.data),
    refetchInterval: 30_000,
  })

  const [modal, setModal] = useState<
    | { mode: 'add'; type?: IntegrationType }
    | { mode: 'edit'; integration: Integration }
    | null
  >(null)
  const [deleteTarget, setDeleteTarget] = useState<Integration | null>(null)

  // Toggle mutation
  const toggleMut = useMutation({
    mutationFn: (id: number) => integrationsApi.toggle(id),
    onSuccess: (res) => {
      const updated = res.data
      toast.success(`Integration ${updated.is_active ? 'activated' : 'deactivated'}`)
      qc.invalidateQueries({ queryKey: ['integrations'] })
    },
    onError: () => toast.error('Failed to toggle integration'),
  })

  // Sync mutation
  const syncMut = useMutation({
    mutationFn: (id: number) => integrationsApi.sync(id),
    onSuccess: () => {
      toast.success('Sync started in background')
      // Refresh after a short delay to see status change
      setTimeout(() => qc.invalidateQueries({ queryKey: ['integrations'] }), 2000)
    },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      toast.error(msg ?? 'Failed to start sync')
    },
  })

  return (
    <div className="space-y-5">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-foreground">Channel Integrations</h3>
          <p className="text-xs text-subtle mt-0.5">
            Connect Gmail, Outlook, SMTP mailboxes, or external systems via API keys to ingest tickets automatically.
          </p>
        </div>
        <Button size="sm" onClick={() => setModal({ mode: 'add' })}>
          <Plus className="w-4 h-4" />
          Add Integration
        </Button>
      </div>

      {/* Type overview cards */}
      {isLoading ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
        </div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {INTEGRATION_TYPES.map((t) => (
            <TypeCard
              key={t}
              type={t}
              integrations={integrations ?? []}
              onAdd={(type) => setModal({ mode: 'add', type })}
            />
          ))}
        </div>
      )}

      {/* Integration table */}
      <Card>
        <CardHeader>
          <CardTitle>All Integrations</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}
            </div>
          ) : !integrations?.length ? (
            <EmptyState
              title="No integrations configured"
              description="Add a Gmail, Outlook, SMTP, or API integration to start receiving tickets automatically."
            />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-border">
                  {['Name', 'Type', 'Org / Module', 'Active', 'Sync Status', 'Last Sync', 'Actions'].map((h) => (
                    <th key={h} className="px-4 py-2.5 text-left text-xs font-medium text-subtle whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {integrations.map((integration) => {
                  const meta = TYPE_META[integration.type]
                  const Icon = meta.icon
                  return (
                    <tr key={integration.id} className="hover:bg-surface-card/50">
                      {/* Name */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className={cn('w-6 h-6 rounded border flex items-center justify-center flex-shrink-0', meta.color)}>
                            <Icon className="w-3 h-3" />
                          </div>
                          <span className="text-sm font-medium text-foreground truncate max-w-[150px]">
                            {integration.name}
                          </span>
                        </div>
                      </td>

                      {/* Type badge */}
                      <td className="px-4 py-3">
                        <Badge variant="blue">{meta.label}</Badge>
                      </td>

                      {/* Org / Module */}
                      <td className="px-4 py-3 text-xs text-subtle">
                        <span className="text-foreground">{integration.org}</span>
                        <span className="mx-1 text-subtle/40">/</span>
                        {integration.module}
                      </td>

                      {/* Active toggle */}
                      <td className="px-4 py-3">
                        <Switch
                          checked={integration.is_active}
                          onCheckedChange={() => toggleMut.mutate(integration.id)}
                          disabled={toggleMut.isPending}
                        />
                      </td>

                      {/* Sync status */}
                      <td className="px-4 py-3">
                        <SyncStatusPill
                          status={integration.sync_status}
                          error={integration.sync_error}
                        />
                      </td>

                      {/* Last synced */}
                      <td className="px-4 py-3 text-xs text-subtle whitespace-nowrap">
                        {integration.last_synced_at ? formatDate(integration.last_synced_at) : '—'}
                      </td>

                      {/* Actions */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          {/* Edit */}
                          <button
                            title="Edit"
                            onClick={() => setModal({ mode: 'edit', integration })}
                            className="p-1.5 rounded text-muted hover:text-foreground hover:bg-surface-border transition-colors"
                          >
                            <Settings2 className="w-3.5 h-3.5" />
                          </button>

                          {/* Sync now (not for API type) */}
                          {integration.type !== 'api' && (
                            <button
                              title="Sync now"
                              onClick={() => syncMut.mutate(integration.id)}
                              disabled={syncMut.isPending || integration.sync_status === 'running'}
                              className="p-1.5 rounded text-muted hover:text-brand-400 hover:bg-brand-500/10 transition-colors disabled:opacity-40"
                            >
                              <RefreshCw className={cn('w-3.5 h-3.5', integration.sync_status === 'running' && 'animate-spin')} />
                            </button>
                          )}

                          {/* Delete */}
                          <button
                            title="Delete"
                            onClick={() => setDeleteTarget(integration)}
                            className="p-1.5 rounded text-muted hover:text-red-400 hover:bg-red-500/10 transition-colors"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Modals */}
      {modal?.mode === 'add' && (
        <IntegrationModal
          mode="add"
          defaultType={modal.type}
          onClose={() => setModal(null)}
          onSaved={() => setModal(null)}
        />
      )}
      {modal?.mode === 'edit' && (
        <IntegrationModal
          mode="edit"
          integration={modal.integration}
          onClose={() => setModal(null)}
          onSaved={() => setModal(null)}
        />
      )}
      {deleteTarget && (
        <DeleteConfirm
          integration={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={() => setDeleteTarget(null)}
        />
      )}
    </div>
  )
}
