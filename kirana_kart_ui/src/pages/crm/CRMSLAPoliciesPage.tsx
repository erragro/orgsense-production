import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Clock, AlertTriangle, Shield, Users, FileText,
  Edit2, X, Info, RefreshCw, TrendingUp, CheckSquare,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card'
import { Spinner } from '@/components/ui/Spinner'
import { crmApi } from '@/api/governance/crm.api'
import type { SLAPolicy } from '@/types/crm.types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function minutesToHoursMin(minutes: number): { hours: number; mins: number } {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return { hours: h, mins: m }
}

function hoursMinToMinutes(hours: number, mins: number): number {
  return hours * 60 + mins
}

function formatSLA(minutes: number): string {
  if (minutes <= 0) return '0m'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h > 0 && m > 0) return `${h}h ${m}m`
  if (h > 0) return `${h}h 0m`
  return `${m}m`
}

function formatPreviewTime(minutes: number): string {
  if (minutes <= 0) return '—'
  const now = new Date()
  const due = new Date(now.getTime() + minutes * 60 * 1000)
  return due.toLocaleString('en-IN', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatUpdatedAt(dateStr: string | null): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

// ---------------------------------------------------------------------------
// Queue type metadata
// ---------------------------------------------------------------------------

interface QueueMeta {
  label: string
  description: string
  textColor: string
  bgColor: string
  borderColor: string
  Icon: React.ElementType
}

const QUEUE_META: Record<string, QueueMeta> = {
  ESCALATION_QUEUE: {
    label: 'Escalation Queue',
    description: 'Critical escalations requiring immediate attention',
    textColor: 'text-red-600',
    bgColor: 'bg-red-50',
    borderColor: 'border-red-200',
    Icon: AlertTriangle,
  },
  SLA_BREACH_REVIEW: {
    label: 'SLA Breach Review',
    description: 'Tickets that have already breached SLA',
    textColor: 'text-amber-600',
    bgColor: 'bg-amber-50',
    borderColor: 'border-amber-200',
    Icon: Clock,
  },
  SENIOR_REVIEW: {
    label: 'Senior Review',
    description: 'High-priority cases requiring senior agent review',
    textColor: 'text-blue-600',
    bgColor: 'bg-blue-50',
    borderColor: 'border-blue-200',
    Icon: Shield,
  },
  MANUAL_REVIEW: {
    label: 'Manual Review',
    description: 'Cases requiring manual human review',
    textColor: 'text-purple-600',
    bgColor: 'bg-purple-50',
    borderColor: 'border-purple-200',
    Icon: Users,
  },
  STANDARD_REVIEW: {
    label: 'Standard Review',
    description: 'Routine support tickets',
    textColor: 'text-emerald-600',
    bgColor: 'bg-emerald-50',
    borderColor: 'border-emerald-200',
    Icon: FileText,
  },
}

const QUEUE_ORDER = [
  'ESCALATION_QUEUE',
  'SLA_BREACH_REVIEW',
  'SENIOR_REVIEW',
  'MANUAL_REVIEW',
  'STANDARD_REVIEW',
]

function getQueueMeta(queueType: string): QueueMeta {
  return (
    QUEUE_META[queueType] ?? {
      label: queueType,
      description: '',
      textColor: 'text-gray-600',
      bgColor: 'bg-gray-50',
      borderColor: 'border-gray-200',
      Icon: CheckSquare,
    }
  )
}

// ---------------------------------------------------------------------------
// SLA progress bars
// ---------------------------------------------------------------------------

function SLAProgressBars({
  resolutionMinutes,
  firstResponseMinutes,
}: {
  resolutionMinutes: number
  firstResponseMinutes: number
}) {
  const max = resolutionMinutes || 1
  const frPct = Math.min((firstResponseMinutes / max) * 100, 100)

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted w-28 shrink-0">Resolution</span>
        <div className="flex-1 h-2 bg-surface-border rounded-full overflow-hidden">
          <div className="h-full bg-brand-500 rounded-full" style={{ width: '100%' }} />
        </div>
        <span className="text-xs font-medium text-foreground w-14 text-right">
          {formatSLA(resolutionMinutes)}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted w-28 shrink-0">First Response</span>
        <div className="flex-1 h-2 bg-surface-border rounded-full overflow-hidden">
          <div
            className="h-full bg-emerald-500 rounded-full"
            style={{ width: `${frPct}%` }}
          />
        </div>
        <span className="text-xs font-medium text-foreground w-14 text-right">
          {formatSLA(firstResponseMinutes)}
        </span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Policy card
// ---------------------------------------------------------------------------

function PolicyCard({
  policy,
  onEdit,
}: {
  policy: SLAPolicy
  onEdit: (policy: SLAPolicy) => void
}) {
  const meta = getQueueMeta(policy.queue_type)
  const { Icon } = meta
  const res = minutesToHoursMin(policy.resolution_minutes)
  const fr = minutesToHoursMin(policy.first_response_minutes)

  return (
    <Card className={`border ${meta.borderColor} hover:shadow-md transition-shadow duration-150`}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className={`p-2.5 rounded-lg ${meta.bgColor} shrink-0`}>
              <Icon className={`w-5 h-5 ${meta.textColor}`} />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-sm font-semibold text-foreground truncate">
                {meta.label}
              </CardTitle>
              <p className="text-xs text-muted mt-0.5 line-clamp-2">{meta.description}</p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onEdit(policy)}
            className="shrink-0 text-xs gap-1.5"
          >
            <Edit2 className="w-3.5 h-3.5" />
            Edit
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Resolution — large display */}
        <div>
          <div className="text-2xl font-bold text-foreground tracking-tight">
            {res.hours > 0 ? `${res.hours}h ` : ''}
            {res.mins > 0 || res.hours === 0 ? `${res.mins}m` : ''}
          </div>
          <div className="text-xs font-medium text-muted uppercase tracking-wide mt-0.5">
            Resolution Target
          </div>
        </div>

        {/* First Response — medium display */}
        <div className="-mt-1">
          <div className="text-lg font-semibold text-foreground">
            {fr.hours > 0 ? `${fr.hours}h ` : ''}
            {fr.mins > 0 || fr.hours === 0 ? `${fr.mins}m` : ''}
          </div>
          <div className="text-xs font-medium text-muted uppercase tracking-wide mt-0.5">
            First Response Target
          </div>
        </div>

        {/* Visual progress bars */}
        <SLAProgressBars
          resolutionMinutes={policy.resolution_minutes}
          firstResponseMinutes={policy.first_response_minutes}
        />

        {/* Card footer */}
        <div className="pt-1 border-t border-surface-border flex items-center justify-between gap-2">
          <span className="text-xs text-muted truncate">
            {policy.updated_by_name
              ? `Last updated by ${policy.updated_by_name}`
              : 'Never updated'}
          </span>
          {policy.updated_at && (
            <span className="text-xs text-muted shrink-0">
              {formatUpdatedAt(policy.updated_at)}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Edit modal — form types & validation
// ---------------------------------------------------------------------------

interface EditFormState {
  resHours: string
  resMins: string
  frHours: string
  frMins: string
}

interface ValidationErrors {
  resHours?: string
  resMins?: string
  frHours?: string
  frMins?: string
  general?: string
}

function parseIntField(val: string): number | null {
  const n = parseInt(val, 10)
  return isNaN(n) ? null : n
}

function validateEditForm(state: EditFormState): ValidationErrors {
  const errors: ValidationErrors = {}

  const rh = parseIntField(state.resHours)
  const rm = parseIntField(state.resMins)
  const fh = parseIntField(state.frHours)
  const fm = parseIntField(state.frMins)

  if (rh === null || rh < 0) errors.resHours = 'Enter a valid number ≥ 0'
  if (rm === null || rm < 0 || rm > 59) errors.resMins = 'Must be 0–59'
  if (fh === null || fh < 0) errors.frHours = 'Enter a valid number ≥ 0'
  if (fm === null || fm < 0 || fm > 59) errors.frMins = 'Must be 0–59'

  if (!errors.resHours && !errors.resMins) {
    const totalRes = hoursMinToMinutes(rh!, rm!)
    if (totalRes <= 0) {
      errors.general = 'Resolution SLA must be greater than 0 minutes'
      return errors
    }

    if (!errors.frHours && !errors.frMins) {
      const totalFr = hoursMinToMinutes(fh!, fm!)
      if (totalFr <= 0) {
        errors.general = 'First response SLA must be greater than 0 minutes'
      } else if (totalFr >= totalRes) {
        errors.general =
          'Resolution target must be longer than the first response target'
      }
    }
  }

  return errors
}

// ---------------------------------------------------------------------------
// Edit modal component
// ---------------------------------------------------------------------------

function EditModal({
  policy,
  onClose,
  onSaved,
}: {
  policy: SLAPolicy
  onClose: () => void
  onSaved: () => void
}) {
  const queryClient = useQueryClient()
  const meta = getQueueMeta(policy.queue_type)

  const initRes = minutesToHoursMin(policy.resolution_minutes)
  const initFr = minutesToHoursMin(policy.first_response_minutes)

  const [form, setForm] = useState<EditFormState>({
    resHours: String(initRes.hours),
    resMins: String(initRes.mins),
    frHours: String(initFr.hours),
    frMins: String(initFr.mins),
  })
  const [errors, setErrors] = useState<ValidationErrors>({})
  const [touched, setTouched] = useState(false)

  const mutation = useMutation({
    mutationFn: ({
      resolution_minutes,
      first_response_minutes,
    }: {
      resolution_minutes: number
      first_response_minutes: number
    }) =>
      crmApi.slaPolicies.update(policy.queue_type, {
        resolution_minutes,
        first_response_minutes,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sla-policies'] })
      onSaved()
    },
  })

  // Derived preview minutes
  const resMinutes = hoursMinToMinutes(
    parseIntField(form.resHours) ?? 0,
    parseIntField(form.resMins) ?? 0,
  )
  const frMinutes = hoursMinToMinutes(
    parseIntField(form.frHours) ?? 0,
    parseIntField(form.frMins) ?? 0,
  )

  const handleChange = (field: keyof EditFormState, value: string) => {
    const next = { ...form, [field]: value }
    setForm(next)
    if (touched) setErrors(validateEditForm(next))
  }

  const handleBlur = () => {
    setTouched(true)
    setErrors(validateEditForm(form))
  }

  const handleSave = () => {
    setTouched(true)
    const errs = validateEditForm(form)
    setErrors(errs)
    if (Object.keys(errs).length > 0) return
    mutation.mutate({
      resolution_minutes: resMinutes,
      first_response_minutes: frMinutes,
    })
  }

  // Escape key to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !mutation.isPending) onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, mutation.isPending])

  const hasErrors = Object.keys(errors).length > 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={() => { if (!mutation.isPending) onClose() }}
      />

      {/* Modal panel */}
      <div className="relative z-10 w-full max-w-lg bg-surface-card border border-surface-border rounded-xl shadow-2xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-surface-border shrink-0">
          <div>
            <h2 className="text-base font-semibold text-foreground">
              Edit SLA Policy — {meta.label}
            </h2>
            <p className="text-xs text-muted mt-0.5">{meta.description}</p>
          </div>
          <button
            onClick={() => { if (!mutation.isPending) onClose() }}
            className="p-1.5 rounded-md text-muted hover:text-foreground hover:bg-surface-2 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          {/* General validation error */}
          {errors.general && (
            <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2.5">
              <AlertTriangle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
              <span className="text-xs text-red-700">{errors.general}</span>
            </div>
          )}

          {/* API save error */}
          {mutation.isError && !errors.general && (
            <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2.5">
              <AlertTriangle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
              <span className="text-xs text-red-700">
                Failed to save changes. Please try again.
              </span>
            </div>
          )}

          {/* ---- Resolution SLA ---- */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-brand-500" />
              <h3 className="text-sm font-semibold text-foreground">Resolution Target</h3>
            </div>
            <p className="text-xs text-muted -mt-1">
              Tickets not resolved within this window will be breached and auto-escalated
            </p>

            <div className="flex items-start gap-3">
              <div className="flex-1">
                <label className="text-xs font-medium text-muted mb-1 block">Hours</label>
                <Input
                  type="number"
                  min={0}
                  value={form.resHours}
                  onChange={e => handleChange('resHours', e.target.value)}
                  onBlur={handleBlur}
                  error={errors.resHours}
                  placeholder="0"
                />
              </div>
              <div className="pt-6 text-muted text-lg font-light select-none">:</div>
              <div className="flex-1">
                <label className="text-xs font-medium text-muted mb-1 block">Minutes</label>
                <Input
                  type="number"
                  min={0}
                  max={59}
                  value={form.resMins}
                  onChange={e => handleChange('resMins', e.target.value)}
                  onBlur={handleBlur}
                  error={errors.resMins}
                  placeholder="0"
                />
              </div>
            </div>

            {resMinutes > 0 && !errors.resHours && !errors.resMins && (
              <div className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2">
                <Clock className="w-3.5 h-3.5 text-brand-400 shrink-0" />
                <span className="text-xs text-muted">
                  Ticket created now must be resolved by{' '}
                  <span className="font-medium text-foreground">
                    {formatPreviewTime(resMinutes)}
                  </span>
                </span>
              </div>
            )}
          </div>

          <div className="border-t border-surface-border" />

          {/* ---- First Response SLA ---- */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-emerald-500" />
              <h3 className="text-sm font-semibold text-foreground">First Response Target</h3>
            </div>
            <p className="text-xs text-muted -mt-1">
              Time for first agent response after ticket is received
            </p>

            <div className="flex items-start gap-3">
              <div className="flex-1">
                <label className="text-xs font-medium text-muted mb-1 block">Hours</label>
                <Input
                  type="number"
                  min={0}
                  value={form.frHours}
                  onChange={e => handleChange('frHours', e.target.value)}
                  onBlur={handleBlur}
                  error={errors.frHours}
                  placeholder="0"
                />
              </div>
              <div className="pt-6 text-muted text-lg font-light select-none">:</div>
              <div className="flex-1">
                <label className="text-xs font-medium text-muted mb-1 block">Minutes</label>
                <Input
                  type="number"
                  min={0}
                  max={59}
                  value={form.frMins}
                  onChange={e => handleChange('frMins', e.target.value)}
                  onBlur={handleBlur}
                  error={errors.frMins}
                  placeholder="0"
                />
              </div>
            </div>

            {frMinutes > 0 && !errors.frHours && !errors.frMins && (
              <div className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2">
                <Clock className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span className="text-xs text-muted">
                  First response needed by{' '}
                  <span className="font-medium text-foreground">
                    {formatPreviewTime(frMinutes)}
                  </span>
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 p-5 border-t border-surface-border shrink-0">
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
            onClick={handleSave}
            disabled={mutation.isPending || (touched && hasErrors)}
            className="min-w-[120px]"
          >
            {mutation.isPending ? (
              <span className="flex items-center gap-2">
                <Spinner className="w-3.5 h-3.5" />
                Saving…
              </span>
            ) : (
              'Save Changes'
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function CRMSLAPoliciesPage() {
  const [editingPolicy, setEditingPolicy] = useState<SLAPolicy | null>(null)

  const {
    data: policies,
    isLoading,
    isError,
    refetch,
    dataUpdatedAt,
  } = useQuery({
    queryKey: ['sla-policies'],
    queryFn: () => crmApi.slaPolicies.list().then(r => r.data),
    staleTime: 30_000,
  })

  const sortedPolicies: SLAPolicy[] = policies
    ? [...policies].sort(
        (a, b) =>
          QUEUE_ORDER.indexOf(a.queue_type) - QUEUE_ORDER.indexOf(b.queue_type),
      )
    : []

  const lastFetched = dataUpdatedAt
    ? new Date(dataUpdatedAt).toLocaleTimeString('en-IN', {
        hour: '2-digit',
        minute: '2-digit',
      })
    : null

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-6 space-y-6">
      {/* Page header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-foreground">SLA Policies</h1>
          <p className="text-sm text-muted mt-0.5">
            Define resolution and first-response time targets per queue type
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {lastFetched && (
            <span className="text-xs text-muted hidden sm:block">
              Last refreshed at {lastFetched}
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => refetch()}
            className="gap-1.5"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </Button>
        </div>
      </div>

      {/* Info banner */}
      <div className="flex items-start gap-3 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3">
        <Info className="w-4 h-4 text-blue-600 mt-0.5 shrink-0" />
        <p className="text-sm text-blue-800">
          SLA policies define how quickly tickets must be handled. Breached tickets are
          automatically escalated.
        </p>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="flex items-center justify-center h-48">
          <Spinner className="w-8 h-8 text-brand-500" />
        </div>
      )}

      {/* Error */}
      {isError && !isLoading && (
        <div className="flex flex-col items-center justify-center h-48 gap-3 text-center">
          <AlertTriangle className="w-8 h-8 text-red-400" />
          <p className="text-sm text-muted">Failed to load SLA policies</p>
          <Button variant="ghost" size="sm" onClick={() => refetch()}>
            Try again
          </Button>
        </div>
      )}

      {/* Empty */}
      {!isLoading && !isError && sortedPolicies.length === 0 && (
        <div className="flex flex-col items-center justify-center h-48 gap-2">
          <Clock className="w-8 h-8 text-muted" />
          <p className="text-sm text-muted">No SLA policies configured yet</p>
        </div>
      )}

      {/* Policy cards grid */}
      {!isLoading && !isError && sortedPolicies.length > 0 && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {sortedPolicies.map(policy => (
              <PolicyCard
                key={policy.queue_type}
                policy={policy}
                onEdit={setEditingPolicy}
              />
            ))}
          </div>

          {/* Legend */}
          <div className="flex flex-wrap items-center gap-4 pt-1 text-xs text-muted">
            <span>Progress bar legend:</span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-2 rounded-full bg-brand-500 inline-block" />
              Resolution window (100%)
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-2 rounded-full bg-emerald-500 inline-block" />
              First response (proportional)
            </span>
          </div>
        </>
      )}

      {/* Edit modal */}
      {editingPolicy && (
        <EditModal
          policy={editingPolicy}
          onClose={() => setEditingPolicy(null)}
          onSaved={() => setEditingPolicy(null)}
        />
      )}
    </div>
  )
}
