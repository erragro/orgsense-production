import { useState,useEffect } from 'react'
import { useQuery,useMutation,useQueryClient } from '@tanstack/react-query'
import {
Users,Plus,Shield,AlertTriangle,TrendingUp,Star,
ChevronRight,X,UserPlus,UserMinus,Settings,Mail,
Code2,Brain,Activity,Eye,EyeOff,RefreshCw,Copy,
CheckCircle2,ExternalLink,Link,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { Card,CardContent,CardHeader,CardTitle } from '@/components/ui/Card'
import { Spinner } from '@/components/ui/Spinner'
import { Switch } from '@/components/ui/Switch'
import { crmApi } from '@/api/governance/crm.api'
import { useAuthStore } from '@/stores/auth.store'
import { hasPermission } from '@/lib/access'
import type { Group,GroupMember,AutomationRule,AgentSummary } from '@/types/crm.types'

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const GROUP_TYPE_COLORS: Record<string, string> = {
  SUPPORT: 'bg-blue-500/15 text-blue-500 border-blue-500/20',
  FRAUD_REVIEW: 'bg-red-500/15 text-red-500 border-red-500/20',
  ESCALATION: 'bg-amber-500/15 text-amber-500 border-amber-500/20',
  SENIOR_REVIEW: 'bg-purple-500/15 text-purple-500 border-purple-500/20',
  CUSTOM: 'bg-gray-500/15 text-gray-400 border-gray-500/20',
}

const GROUP_TYPE_DOT: Record<string, string> = {
  SUPPORT: 'bg-blue-500',
  FRAUD_REVIEW: 'bg-red-500',
  ESCALATION: 'bg-amber-500',
  SENIOR_REVIEW: 'bg-purple-500',
  CUSTOM: 'bg-gray-400',
}

const GROUP_TYPE_ICON: Record<string, React.ElementType> = {
  SUPPORT: Users,
  FRAUD_REVIEW: Shield,
  ESCALATION: AlertTriangle,
  SENIOR_REVIEW: Star,
  CUSTOM: TrendingUp,
}

const GROUP_TYPE_DESCRIPTIONS: Record<string, string> = {
  SUPPORT: 'General customer support team',
  FRAUD_REVIEW: 'Specialized fraud investigation team',
  ESCALATION: 'Handles escalated high-priority cases',
  SENIOR_REVIEW: 'Senior agents for complex cases',
  CUSTOM: 'Custom team with flexible configuration',
}

const ROUTING_LABELS: Record<string, string> = {
  ROUND_ROBIN: 'Round Robin',
  LEAST_BUSY: 'Least Busy',
  MANUAL: 'Manual',
}

const ROUTING_DESCRIPTIONS: Record<string, string> = {
  ROUND_ROBIN: 'Distribute tickets evenly among online agents',
  LEAST_BUSY: 'Assign to the agent with fewest open tickets',
  MANUAL: 'Assign tickets manually',
}

const AVAILABILITY_DOT: Record<string, string> = {
  ONLINE: 'bg-green-500',
  BUSY: 'bg-amber-500',
  AWAY: 'bg-yellow-400',
  OFFLINE: 'bg-gray-400',
}

const AVAILABILITY_LABEL: Record<string, string> = {
  ONLINE: 'Online',
  BUSY: 'Busy',
  AWAY: 'Away',
  OFFLINE: 'Offline',
}

const ROLE_BADGE: Record<string, string> = {
  AGENT: 'bg-blue-500/10 text-blue-500 border-blue-500/20',
  LEAD: 'bg-purple-500/10 text-purple-500 border-purple-500/20',
  MANAGER: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
}

function getGroupTypeIcon(type: string): React.ElementType {
  return GROUP_TYPE_ICON[type] ?? Users
}

function getInitials(name: string | null, email: string): string {
  if (name && name.trim()) {
    const parts = name.trim().split(' ')
    return parts.length >= 2
      ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
      : parts[0][0].toUpperCase()
  }
  return email[0].toUpperCase()
}

// ---------------------------------------------------------------------------
// Integration types (may not be in backend yet)
// ---------------------------------------------------------------------------

interface EmailIntegration {
  id: number
  inbox_email: string
  display_name: string
  polling_interval: string
  from_filter: string
  subject_filter: string
  is_configured: boolean
}

interface ApiIntegration {
  id: number
  api_key: string | null
  endpoint_url: string
}

interface GroupIntegrations {
  email?: EmailIntegration
  api?: ApiIntegration
}

// ---------------------------------------------------------------------------
// Create Group Modal
// ---------------------------------------------------------------------------

const GROUP_TYPE_OPTIONS = [
  { value: 'SUPPORT', label: 'Support' },
  { value: 'FRAUD_REVIEW', label: 'Fraud Review' },
  { value: 'ESCALATION', label: 'Escalation' },
  { value: 'SENIOR_REVIEW', label: 'Senior Review' },
  { value: 'CUSTOM', label: 'Custom' },
]

const ROUTING_OPTIONS = [
  { value: 'ROUND_ROBIN', label: 'Round Robin' },
  { value: 'LEAST_BUSY', label: 'Least Busy' },
  { value: 'MANUAL', label: 'Manual' },
]

const POLLING_OPTIONS = [
  { value: '30', label: 'Every 30 seconds' },
  { value: '60', label: 'Every 1 minute' },
  { value: '300', label: 'Every 5 minutes' },
]

const ROLE_OPTIONS = [
  { value: 'AGENT', label: 'Agent' },
  { value: 'LEAD', label: 'Lead' },
  { value: 'MANAGER', label: 'Manager' },
]

function CreateGroupModal({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: () => void
}) {
  const [form, setForm] = useState({
    name: '',
    description: '',
    group_type: 'SUPPORT',
    routing_strategy: 'ROUND_ROBIN',
  })
  const [error, setError] = useState('')

  const mutation = useMutation({
    mutationFn: () => crmApi.groups.create(form).then(r => r.data),
    onSuccess: () => { onCreated(); onClose() },
    onError: (e: any) =>
      setError(e?.response?.data?.detail || 'Failed to create group'),
  })

  const selectedTypeDesc =
    GROUP_TYPE_DESCRIPTIONS[form.group_type] ?? ''
  const selectedRoutingDesc =
    ROUTING_DESCRIPTIONS[form.routing_strategy] ?? ''

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !mutation.isPending) onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, mutation.isPending])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={() => { if (!mutation.isPending) onClose() }}
      />
      <div className="relative z-10 w-full max-w-md bg-surface-card border border-surface-border rounded-xl shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-surface-border">
          <h2 className="text-base font-semibold text-foreground">New Agent Group</h2>
          <button
            onClick={() => { if (!mutation.isPending) onClose() }}
            className="p-1.5 rounded-md text-muted hover:text-foreground hover:bg-surface-2 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          {error && (
            <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2.5">
              <AlertTriangle className="w-4 h-4 text-red-500 shrink-0" />
              <span className="text-xs text-red-700">{error}</span>
            </div>
          )}

          <Input
            label="Group Name *"
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder="e.g. Fraud Review Team"
          />

          <Textarea
            label="Description"
            value={form.description}
            onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
            placeholder="Optional description of this group's purpose"
            rows={2}
          />

          <div className="space-y-1">
            <Select
              label="Group Type"
              options={GROUP_TYPE_OPTIONS}
              value={form.group_type}
              onChange={e => setForm(f => ({ ...f, group_type: e.target.value }))}
            />
            {selectedTypeDesc && (
              <p className="text-xs text-muted ml-0.5">{selectedTypeDesc}</p>
            )}
          </div>

          <div className="space-y-1">
            <Select
              label="Routing Strategy"
              options={ROUTING_OPTIONS}
              value={form.routing_strategy}
              onChange={e => setForm(f => ({ ...f, routing_strategy: e.target.value }))}
            />
            {selectedRoutingDesc && (
              <p className="text-xs text-muted ml-0.5">{selectedRoutingDesc}</p>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 p-5 border-t border-surface-border">
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            disabled={mutation.isPending}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => mutation.mutate()}
            disabled={!form.name.trim() || mutation.isPending}
            className="min-w-[120px]"
          >
            {mutation.isPending ? (
              <span className="flex items-center gap-2">
                <Spinner className="w-3.5 h-3.5" />
                Creating…
              </span>
            ) : (
              'Create Group'
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Group card
// ---------------------------------------------------------------------------

function GroupCard({
  group,
  onManage,
}: {
  group: Group
  onManage: (group: Group) => void
}) {
  const Icon = getGroupTypeIcon(group.group_type)
  const dotColor = GROUP_TYPE_DOT[group.group_type] ?? 'bg-gray-400'
  const typeColors = GROUP_TYPE_COLORS[group.group_type] ?? GROUP_TYPE_COLORS.CUSTOM

  return (
    <Card className="hover:shadow-md transition-shadow duration-150 border border-surface-border">
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="flex items-center gap-3">
            <div className="relative shrink-0">
              <div className={`p-2.5 rounded-lg border ${typeColors}`}>
                <Icon className="w-4 h-4" />
              </div>
              <span
                className={`absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-surface-card ${dotColor}`}
              />
            </div>
            <div className="min-w-0">
              <h3 className="font-semibold text-foreground text-sm truncate">
                {group.name}
              </h3>
              {group.description && (
                <p className="text-xs text-muted line-clamp-1 mt-0.5">
                  {group.description}
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 mb-4">
          <span
            className={`inline-flex items-center text-xs px-2 py-0.5 rounded-full border font-medium ${typeColors}`}
          >
            {ROUTING_LABELS[group.routing_strategy] ?? group.routing_strategy}
          </span>
          {!group.is_active && (
            <span className="inline-flex items-center text-xs px-2 py-0.5 rounded-full border bg-gray-100 text-gray-500 border-gray-200 font-medium">
              Inactive
            </span>
          )}
        </div>

        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-xs text-muted">
            <Users className="w-3.5 h-3.5" />
            {group.member_count} {group.member_count === 1 ? 'member' : 'members'}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onManage(group)}
            className="gap-1 text-xs"
          >
            Manage
            <ChevronRight className="w-3.5 h-3.5" />
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Detail drawer — tab: Members
// ---------------------------------------------------------------------------

function MembersTab({
  groupId,
  detail,
  agents,
  canAdmin,
  onRefetch,
}: {
  groupId: number
  detail: Group
  agents: AgentSummary[]
  canAdmin: boolean
  onRefetch: () => void
}) {
  const qc = useQueryClient()
  const [addUserId, setAddUserId] = useState('')
  const [addRole, setAddRole] = useState('AGENT')
  const members: GroupMember[] = detail.members ?? []
  const memberIds = new Set(members.map(m => m.user_id))
  const available = agents.filter(a => !memberIds.has(a.id))

  const addMutation = useMutation({
    mutationFn: () =>
      crmApi.groups.addMember(groupId, {
        user_id: parseInt(addUserId, 10),
        role: addRole,
      }),
    onSuccess: () => {
      setAddUserId('')
      onRefetch()
      qc.invalidateQueries({ queryKey: ['crm-groups'] })
    },
  })

  const removeMutation = useMutation({
    mutationFn: (userId: number) => crmApi.groups.removeMember(groupId, userId),
    onSuccess: () => {
      onRefetch()
      qc.invalidateQueries({ queryKey: ['crm-groups'] })
    },
  })

  return (
    <div className="space-y-4">
      {members.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-10 gap-2">
          <Users className="w-8 h-8 text-muted" />
          <p className="text-sm text-muted">No members in this group yet</p>
          {canAdmin && (
            <p className="text-xs text-muted">Use the form below to add an agent</p>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {members.map(m => {
            const initials = getInitials(m.full_name, m.email)
            const availDot = AVAILABILITY_DOT[m.crm_availability] ?? 'bg-gray-400'
            const roleClass = ROLE_BADGE[m.role] ?? ROLE_BADGE.AGENT

            return (
              <div
                key={m.user_id}
                className="flex items-center justify-between bg-surface-2 rounded-xl px-3.5 py-2.5 gap-3"
              >
                <div className="flex items-center gap-3 min-w-0">
                  {/* Avatar */}
                  <div className="relative shrink-0">
                    <div className="w-8 h-8 rounded-full bg-brand-500/20 text-brand-500 flex items-center justify-center text-xs font-semibold">
                      {initials}
                    </div>
                    <span
                      className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-surface-2 ${availDot}`}
                      title={AVAILABILITY_LABEL[m.crm_availability] ?? m.crm_availability}
                    />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">
                      {m.full_name || m.email}
                    </p>
                    <p className="text-xs text-muted truncate">{m.email}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full border font-medium ${roleClass}`}
                  >
                    {m.role}
                  </span>
                  {canAdmin && (
                    <button
                      onClick={() => removeMutation.mutate(m.user_id)}
                      disabled={removeMutation.isPending}
                      className="p-1 text-muted hover:text-red-500 transition-colors rounded"
                      title="Remove member"
                    >
                      {removeMutation.isPending ? (
                        <Spinner className="w-3.5 h-3.5" />
                      ) : (
                        <UserMinus className="w-3.5 h-3.5" />
                      )}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Add member section */}
      {canAdmin && (
        <div className="border-t border-surface-border pt-4">
          <p className="text-xs font-semibold text-muted uppercase tracking-wide mb-3">
            Add Member
          </p>
          {available.length === 0 ? (
            <p className="text-xs text-muted">All available agents are already in this group</p>
          ) : (
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Select
                  options={[
                    { value: '', label: 'Select agent…' },
                    ...available.map(a => ({
                      value: String(a.id),
                      label: a.full_name || a.email,
                    })),
                  ]}
                  value={addUserId}
                  onChange={e => setAddUserId(e.target.value)}
                />
              </div>
              <div className="w-28">
                <Select
                  options={ROLE_OPTIONS}
                  value={addRole}
                  onChange={e => setAddRole(e.target.value)}
                />
              </div>
              <Button
                size="sm"
                onClick={() => addMutation.mutate()}
                disabled={!addUserId || addMutation.isPending}
                className="gap-1.5 shrink-0"
              >
                {addMutation.isPending ? (
                  <Spinner className="w-3.5 h-3.5" />
                ) : (
                  <UserPlus className="w-3.5 h-3.5" />
                )}
                Add
              </Button>
            </div>
          )}
          {addMutation.isError && (
            <p className="text-xs text-red-500 mt-2">Failed to add member</p>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Detail drawer — tab: Settings
// ---------------------------------------------------------------------------

function SettingsTab({
  groupId,
  detail,
  canAdmin,
  onRefetch,
}: {
  groupId: number
  detail: Group
  canAdmin: boolean
  onRefetch: () => void
}) {
  const qc = useQueryClient()
  const [form, setForm] = useState({
    name: detail.name,
    description: detail.description ?? '',
    group_type: detail.group_type,
    routing_strategy: detail.routing_strategy,
    is_active: detail.is_active,
  })
  const [dirty, setDirty] = useState(false)

  const mutation = useMutation({
    mutationFn: () =>
      crmApi.groups.update(groupId, {
        name: form.name,
        description: form.description || undefined,
        routing_strategy: form.routing_strategy,
        is_active: form.is_active,
      }),
    onSuccess: () => {
      setDirty(false)
      onRefetch()
      qc.invalidateQueries({ queryKey: ['crm-groups'] })
    },
  })

  const handleChange = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => {
    setForm(f => ({ ...f, [k]: v }))
    setDirty(true)
  }

  const showDeactivateWarning = !form.is_active && detail.is_active

  return (
    <div className="space-y-5">
      {mutation.isError && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2.5">
          <AlertTriangle className="w-4 h-4 text-red-500 shrink-0" />
          <span className="text-xs text-red-700">Failed to save changes</span>
        </div>
      )}

      <Input
        label="Group Name"
        value={form.name}
        onChange={e => handleChange('name', e.target.value)}
        disabled={!canAdmin}
      />

      <Textarea
        label="Description"
        value={form.description}
        onChange={e => handleChange('description', e.target.value)}
        rows={3}
        disabled={!canAdmin}
        placeholder="Optional description"
      />

      <Select
        label="Group Type"
        options={GROUP_TYPE_OPTIONS}
        value={form.group_type}
        onChange={e => handleChange('group_type', e.target.value as typeof form.group_type)}
        disabled={!canAdmin}
      />

      <div className="space-y-1">
        <Select
          label="Routing Strategy"
          options={ROUTING_OPTIONS}
          value={form.routing_strategy}
          onChange={e =>
            handleChange('routing_strategy', e.target.value as typeof form.routing_strategy)
          }
          disabled={!canAdmin}
        />
        <p className="text-xs text-muted ml-0.5">
          {ROUTING_DESCRIPTIONS[form.routing_strategy] ?? ''}
        </p>
      </div>

      {canAdmin && (
        <div className="space-y-2">
          <Switch
            checked={form.is_active}
            onCheckedChange={v => handleChange('is_active', v)}
            label={form.is_active ? 'Group is active' : 'Group is inactive'}
          />
          {showDeactivateWarning && (
            <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5">
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <p className="text-xs text-amber-800">
                Deactivating this group will stop new ticket assignments. Existing
                tickets will not be affected.
              </p>
            </div>
          )}
        </div>
      )}

      {canAdmin && (
        <Button
          size="sm"
          onClick={() => mutation.mutate()}
          disabled={!dirty || !form.name.trim() || mutation.isPending}
          className="gap-2"
        >
          {mutation.isPending ? (
            <>
              <Spinner className="w-3.5 h-3.5" />
              Saving…
            </>
          ) : (
            'Save Changes'
          )}
        </Button>
      )}

      {mutation.isSuccess && !dirty && (
        <p className="text-xs text-emerald-600 flex items-center gap-1.5">
          <CheckCircle2 className="w-3.5 h-3.5" />
          Changes saved
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Detail drawer — tab: Integrations
// ---------------------------------------------------------------------------

function EmailIntegrationCard({
  groupId,
  integrations,
  canAdmin,
  onRefetch,
}: {
  groupId: number
  integrations: GroupIntegrations | null
  canAdmin: boolean
  onRefetch: () => void
}) {
  const [form, setForm] = useState({
    inbox_email: integrations?.email?.inbox_email ?? '',
    display_name: integrations?.email?.display_name ?? '',
    polling_interval: integrations?.email?.polling_interval ?? '60',
    from_filter: integrations?.email?.from_filter ?? '',
    subject_filter: integrations?.email?.subject_filter ?? '',
  })
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  const mutation = useMutation({
    mutationFn: () =>
      (integrations?.email
        ? crmApi.groups.updateIntegration(groupId, integrations.email.id, { config: form })
        : crmApi.groups.createIntegration(groupId, { type: 'SMTP_INBOUND', name: form.display_name || 'Email inbox', config: form }))
        .then(r => r.data),
    onSuccess: () => {
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
      onRefetch()
    },
    onError: (e: any) => {
      const status = e?.response?.status
      if (status === 404 || status === 405) {
        setError('Email integration endpoint not yet configured in backend')
      } else {
        setError(e?.response?.data?.detail || 'Failed to save configuration')
      }
    },
  })

  const isConfigured = !!integrations?.email?.inbox_email

  return (
    <Card className="border border-surface-border">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-blue-50">
              <Mail className="w-4 h-4 text-blue-600" />
            </div>
            <div>
              <CardTitle className="text-sm font-semibold text-foreground">
                Email Inbox Integration
              </CardTitle>
              <p className="text-xs text-muted mt-0.5">
                Route incoming emails directly to this group
              </p>
            </div>
          </div>
          <span
            className={`text-xs px-2 py-0.5 rounded-full border font-medium ${
              isConfigured
                ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                : 'bg-gray-100 text-gray-500 border-gray-200'
            }`}
          >
            {isConfigured ? 'Connected' : 'Not configured'}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted">
          Configure an SMTP inbox and emails will automatically create tickets
          assigned to this group.
        </p>

        {error && (
          <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
            <span className="text-xs text-amber-800">{error}</span>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2 sm:col-span-1">
            <Input
              label="Inbox Email Address"
              value={form.inbox_email}
              onChange={e => setForm(f => ({ ...f, inbox_email: e.target.value }))}
              placeholder="fraud@kirana.support"
              disabled={!canAdmin}
            />
          </div>
          <div className="col-span-2 sm:col-span-1">
            <Input
              label="Display Name"
              value={form.display_name}
              onChange={e => setForm(f => ({ ...f, display_name: e.target.value }))}
              placeholder="Fraud Review Team"
              disabled={!canAdmin}
            />
          </div>
        </div>

        <Select
          label="Polling Interval"
          options={POLLING_OPTIONS}
          value={form.polling_interval}
          onChange={e => setForm(f => ({ ...f, polling_interval: e.target.value }))}
          disabled={!canAdmin}
        />

        <Input
          label="From Filter (optional)"
          value={form.from_filter}
          onChange={e => setForm(f => ({ ...f, from_filter: e.target.value }))}
          placeholder="Only process emails from @domain.com"
          disabled={!canAdmin}
        />

        <Input
          label="Subject Filter (optional)"
          value={form.subject_filter}
          onChange={e => setForm(f => ({ ...f, subject_filter: e.target.value }))}
          placeholder="Filter by subject keyword"
          disabled={!canAdmin}
        />

        {canAdmin && (
          <div className="flex items-center gap-3 pt-1">
            <Button
              size="sm"
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending}
              className="gap-2"
            >
              {mutation.isPending ? (
                <>
                  <Spinner className="w-3.5 h-3.5" />
                  Saving…
                </>
              ) : (
                'Save Configuration'
              )}
            </Button>
            {saved && (
              <span className="text-xs text-emerald-600 flex items-center gap-1">
                <CheckCircle2 className="w-3.5 h-3.5" />
                Saved
              </span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function ApiIntegrationCard({
  groupId,
  integrations,
  canAdmin,
  onRefetch,
}: {
  groupId: number
  integrations: GroupIntegrations | null
  canAdmin: boolean
  onRefetch: () => void
}) {
  const [showKey, setShowKey] = useState(false)
  const [copied, setCopied] = useState(false)
  const [genError, setGenError] = useState('')
  const [generatedKey, setGeneratedKey] = useState<string | null>(null)
  const apiKey = generatedKey ?? integrations?.api?.api_key ?? null

  const generateMutation = useMutation({
    mutationFn: () =>
      (integrations?.api
        ? crmApi.groups.regenerateApiKey(groupId, integrations.api.id)
        : crmApi.groups.generateApiKey(groupId, { name: 'Group API key' })).then(r => r.data),
    onSuccess: (result) => {
      setGeneratedKey(result.api_key_full ?? null)
      setGenError('')
      onRefetch()
    },
    onError: (e: any) => {
      const status = e?.response?.status
      if (status === 404 || status === 405) {
        setGenError('Key generation endpoint not yet available in backend')
      } else {
        setGenError(e?.response?.data?.detail || 'Failed to generate key')
      }
    },
  })

  const maskedKey = apiKey
    ? `${apiKey.slice(0, 8)}${'•'.repeat(Math.max(0, apiKey.length - 16))}${apiKey.slice(-8)}`
    : null

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }


  return (
    <Card className="border border-surface-border">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-lg bg-purple-50">
            <Code2 className="w-4 h-4 text-purple-600" />
          </div>
          <div>
            <CardTitle className="text-sm font-semibold text-foreground">
              Direct API Integration
            </CardTitle>
            <p className="text-xs text-muted mt-0.5">
              Manage group credentials. Inbound ticket delivery requires a configured integration.
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {genError && (
          <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
            <span className="text-xs text-amber-800">{genError}</span>
          </div>
        )}

        {/* API Key */}
        <div>
          <label className="text-xs font-medium text-muted block mb-1">
            API Key
          </label>
          {apiKey ? (
            <div className="flex items-center gap-2 bg-surface-2 rounded-lg px-3 py-2 border border-surface-border">
              <span className="text-xs font-mono text-foreground flex-1 truncate">
                {showKey ? apiKey : maskedKey}
              </span>
              <button
                disabled={!generatedKey}
                onClick={() => setShowKey(v => !v)}
                className="text-muted hover:text-foreground transition-colors shrink-0"
              >
                {showKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
              <button
                disabled={!generatedKey}
                onClick={() => generatedKey && handleCopy(generatedKey)}
                title={copied ? "Copied" : "Copy newly generated key"}
                className="text-muted hover:text-foreground transition-colors shrink-0"
              >
                <Copy className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <p className="text-xs text-muted italic">No API key generated yet</p>
          )}
        </div>

        {/* Generate key button */}
        {canAdmin && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => generateMutation.mutate()}
            disabled={generateMutation.isPending}
            className="gap-2"
          >
            {generateMutation.isPending ? (
              <Spinner className="w-3.5 h-3.5" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
            {apiKey ? 'Regenerate Key' : 'Generate API Key'}
          </Button>
        )}

      </CardContent>
    </Card>
  )
}

function CardinalRoutingCard({
  groupId,
  groupName,
  automationRules,
}: {
  groupId: number
  groupName: string
  automationRules: AutomationRule[]
}) {
  const routingRules = automationRules.filter(rule =>
    rule.actions.some(
      a =>
        a.action_type === 'assign_to_group' &&
        (a.params?.group_id === groupId || String(a.params?.group_id) === String(groupId)),
    ),
  )

  return (
    <Card className="border border-surface-border">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-lg bg-emerald-50">
            <Brain className="w-4 h-4 text-emerald-600" />
          </div>
          <div>
            <CardTitle className="text-sm font-semibold text-foreground">
              Cardinal AI Auto-Routing
            </CardTitle>
            <p className="text-xs text-muted mt-0.5">
              Cardinal AI automatically routes tickets to this group based on fraud
              signals and confidence scores
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {routingRules.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-6 gap-2 text-center">
            <Brain className="w-7 h-7 text-muted" />
            <p className="text-sm text-muted">No Cardinal rules route to this group yet</p>
            <p className="text-xs text-muted">
              Create an automation rule with an &ldquo;Assign to Group&rdquo; action targeting{' '}
              <span className="font-medium text-foreground">{groupName}</span>
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {routingRules.map(rule => (
              <div
                key={rule.id}
                className="flex items-start justify-between bg-surface-2 rounded-lg px-3.5 py-3 gap-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{rule.name}</p>
                  {rule.description && (
                    <p className="text-xs text-muted mt-0.5 line-clamp-2">{rule.description}</p>
                  )}
                  <div className="flex items-center gap-2 mt-1.5">
                    <span
                      className={`text-xs px-1.5 py-0.5 rounded border font-medium ${
                        rule.is_active
                          ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                          : 'bg-gray-100 text-gray-500 border-gray-200'
                      }`}
                    >
                      {rule.is_active ? 'Active' : 'Paused'}
                    </span>
                    <span className="text-xs text-muted">
                      {rule.run_count} runs
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="pt-1">
          <a
            href="/crm/automation"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-brand-500 hover:text-brand-600 transition-colors"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            {routingRules.length === 0
              ? '+ Create Routing Rule'
              : 'Manage in Automation'}
          </a>
        </div>
      </CardContent>
    </Card>
  )
}

function IntegrationsTab({
  groupId,
  groupName,
  canAdmin,
}: {
  groupId: number
  groupName: string
  canAdmin: boolean
}) {
  const [integrations, setIntegrations] = useState<GroupIntegrations | null>(null)
  const [integrationsLoading, setIntegrationsLoading] = useState(true)

  const fetchIntegrations = async () => {
    try {
      const res = await crmApi.groups.getIntegrations(groupId)
      const email = res.data.find(item => item.type === 'SMTP_INBOUND')
      const api = res.data.find(item => item.type === 'API_KEY')
      const field = (name: string) => typeof email?.config[name] === 'string' ? String(email.config[name]) : ''
      setIntegrations({
        email: email ? { id: email.id, inbox_email: field('inbox_email'), display_name: field('display_name'), polling_interval: field('polling_interval'), from_filter: field('from_filter'), subject_filter: field('subject_filter'), is_configured: email.is_active } : undefined,
        api: api ? { id: api.id, api_key: api.api_key_masked, endpoint_url: '' } : undefined,
      })
    } catch {
      // Graceful fallback — endpoint may not exist yet
      setIntegrations(null)
    } finally {
      setIntegrationsLoading(false)
    }
  }

  useEffect(() => {
    fetchIntegrations()
  }, [groupId])

  const { data: automationRules = [] } = useQuery({
    queryKey: ['automation-rules-for-groups'],
    queryFn: () => crmApi.automationRules.list().then(r => r.data),
    staleTime: 30_000,
  })

  return (
    <div className="space-y-5">
      {integrationsLoading ? (
        <div className="flex items-center justify-center h-20">
          <Spinner className="w-6 h-6 text-brand-500" />
        </div>
      ) : (
        <>
          <EmailIntegrationCard
            groupId={groupId}
            integrations={integrations}
            canAdmin={canAdmin}
            onRefetch={fetchIntegrations}
          />
          <ApiIntegrationCard
            groupId={groupId}
            integrations={integrations}
            canAdmin={canAdmin}
            onRefetch={fetchIntegrations}
          />
          <CardinalRoutingCard
            groupId={groupId}
            groupName={groupName}
            automationRules={automationRules as AutomationRule[]}
          />
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Detail drawer — tab: Activity
// ---------------------------------------------------------------------------

function ActivityTab({ group }: { group: Group }) {
  const createdDate = new Date(group.created_at).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3">
        <div className="p-1.5 rounded-full bg-surface-2 border border-surface-border mt-0.5 shrink-0">
          <Activity className="w-3.5 h-3.5 text-muted" />
        </div>
        <div>
          <p className="text-sm text-foreground">Group created</p>
          <p className="text-xs text-muted">{createdDate}</p>
        </div>
      </div>
      <div className="flex items-start gap-3">
        <div className="p-1.5 rounded-full bg-surface-2 border border-surface-border mt-0.5 shrink-0">
          <Users className="w-3.5 h-3.5 text-muted" />
        </div>
        <div>
          <p className="text-sm text-foreground">
            {group.member_count} {group.member_count === 1 ? 'member' : 'members'} currently
          </p>
          <p className="text-xs text-muted">Current group size</p>
        </div>
      </div>
      <p className="text-xs text-muted pt-2 italic">
        Detailed activity logs will be available in a future update.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Group Detail Drawer
// ---------------------------------------------------------------------------

type DrawerTab = 'members' | 'settings' | 'integrations' | 'activity'

const DRAWER_TABS: { id: DrawerTab; label: string; Icon: React.ElementType }[] = [
  { id: 'members', label: 'Members', Icon: Users },
  { id: 'settings', label: 'Settings', Icon: Settings },
  { id: 'integrations', label: 'Integrations', Icon: Link },
  { id: 'activity', label: 'Activity', Icon: Activity },
]

function GroupDetailDrawer({
  group,
  canAdmin,
  onClose,
}: {
  group: Group
  canAdmin: boolean
  onClose: () => void
}) {
  const [activeTab, setActiveTab] = useState<DrawerTab>('members')

  const {
    data: detail,
    refetch,
    isLoading,
  } = useQuery({
    queryKey: ['crm-group-detail', group.id],
    queryFn: () => crmApi.groups.get(group.id).then(r => r.data as Group),
    initialData: group,
    staleTime: 10_000,
  })

  const { data: agents = [] } = useQuery({
    queryKey: ['crm-agents-simple'],
    queryFn: () => crmApi.getAgents().then(r => r.data),
    staleTime: 30_000,
  })

  // Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const Icon = getGroupTypeIcon(detail.group_type)
  const typeColors = GROUP_TYPE_COLORS[detail.group_type] ?? GROUP_TYPE_COLORS.CUSTOM

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Drawer — slides in from right */}
      <div className="ml-auto relative z-10 w-full max-w-[640px] h-full bg-surface-card border-l border-surface-border shadow-2xl flex flex-col">
        {/* Drawer header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-surface-border shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className={`p-2.5 rounded-lg border ${typeColors} shrink-0`}>
              <Icon className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h2 className="font-semibold text-foreground truncate">{detail.name}</h2>
              <p className="text-xs text-muted mt-0.5">
                {detail.member_count} {detail.member_count === 1 ? 'member' : 'members'} ·{' '}
                {ROUTING_LABELS[detail.routing_strategy] ?? detail.routing_strategy}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-md text-muted hover:text-foreground hover:bg-surface-2 transition-colors shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-surface-border shrink-0 px-2">
          {DRAWER_TABS.map(tab => {
            const TabIcon = tab.Icon
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 px-3 py-3 text-xs font-medium border-b-2 transition-colors ${
                  activeTab === tab.id
                    ? 'border-brand-500 text-brand-500'
                    : 'border-transparent text-muted hover:text-foreground'
                }`}
              >
                <TabIcon className="w-3.5 h-3.5" />
                {tab.label}
              </button>
            )
          })}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto p-5">
          {isLoading ? (
            <div className="flex items-center justify-center h-32">
              <Spinner className="w-7 h-7 text-brand-500" />
            </div>
          ) : (
            <>
              {activeTab === 'members' && (
                <MembersTab
                  groupId={group.id}
                  detail={detail}
                  agents={agents as AgentSummary[]}
                  canAdmin={canAdmin}
                  onRefetch={() => refetch()}
                />
              )}
              {activeTab === 'settings' && (
                <SettingsTab
                  groupId={group.id}
                  detail={detail}
                  canAdmin={canAdmin}
                  onRefetch={() => refetch()}
                />
              )}
              {activeTab === 'integrations' && (
                <IntegrationsTab
                  groupId={group.id}
                  groupName={detail.name}
                  canAdmin={canAdmin}
                />
              )}
              {activeTab === 'activity' && <ActivityTab group={detail} />}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function CRMGroupsPage() {
  const { user } = useAuthStore()
  const canAdmin = hasPermission(user, 'crm', 'admin')
  const qc = useQueryClient()

  const [showCreate, setShowCreate] = useState(false)
  const [managingGroup, setManagingGroup] = useState<Group | null>(null)

  const { data: groups = [], isLoading, isError, refetch } = useQuery({
    queryKey: ['crm-groups'],
    queryFn: () => crmApi.groups.list().then(r => r.data as Group[]),
    staleTime: 20_000,
  })

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-6 space-y-6">
      {/* Page header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-foreground">Agent Groups</h1>
          <p className="text-sm text-muted mt-0.5">
            Manage team routing and channel integrations
          </p>
        </div>
        {canAdmin && (
          <Button
            size="sm"
            onClick={() => setShowCreate(true)}
            className="gap-1.5 shrink-0"
          >
            <Plus className="w-4 h-4" />
            New Group
          </Button>
        )}
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-44 bg-surface-2 rounded-xl animate-pulse" />
          ))}
        </div>
      )}

      {/* Error */}
      {isError && !isLoading && (
        <div className="flex flex-col items-center justify-center h-48 gap-3">
          <AlertTriangle className="w-8 h-8 text-red-400" />
          <p className="text-sm text-muted">Failed to load groups</p>
          <Button variant="ghost" size="sm" onClick={() => refetch()}>
            Try again
          </Button>
        </div>
      )}

      {/* Empty */}
      {!isLoading && !isError && groups.length === 0 && (
        <div className="flex flex-col items-center justify-center h-60 gap-3">
          <Users className="w-12 h-12 text-muted opacity-40" />
          <p className="text-sm text-muted">No groups yet</p>
          {canAdmin && (
            <Button
              size="sm"
              onClick={() => setShowCreate(true)}
              className="gap-1.5"
            >
              <Plus className="w-4 h-4" />
              Create First Group
            </Button>
          )}
        </div>
      )}

      {/* Groups grid */}
      {!isLoading && !isError && groups.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {groups.map(group => (
            <GroupCard
              key={group.id}
              group={group}
              onManage={setManagingGroup}
            />
          ))}
        </div>
      )}

      {/* Create modal */}
      {showCreate && (
        <CreateGroupModal
          onClose={() => setShowCreate(false)}
          onCreated={() => qc.invalidateQueries({ queryKey: ['crm-groups'] })}
        />
      )}

      {/* Group detail drawer */}
      {managingGroup && (
        <GroupDetailDrawer
          group={managingGroup}
          canAdmin={canAdmin}
          onClose={() => setManagingGroup(null)}
        />
      )}
    </div>
  )
}
