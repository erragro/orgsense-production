// src/pages/cardinal/tabs/SchedulersTab.tsx
// ==========================================
// Schedulers tab — view and manage Celery Beat periodic tasks.
// Toggle enable/disable takes effect on next beat tick (no restart).
// Interval/cron changes are stored and take effect on next scheduler restart.
// Manual trigger fires the task immediately via Celery send_task.
// Edit + Toggle + Run Now require cardinal.admin permission.

import { useState } from 'react'
import { useQuery,useMutation,useQueryClient } from '@tanstack/react-query'
import { Card,CardContent,CardHeader,CardTitle } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Skeleton } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/common/EmptyState'
import { cardinalApi } from '@/api/governance/cardinal.api'
import { useAuthStore } from '@/stores/auth.store'
import { hasPermission } from '@/lib/access'
import { toast } from '@/stores/toast.store'
import { formatDate } from '@/lib/dates'
import type { BeatSchedule } from '@/types/cardinal.types'
import { cn } from '@/lib/cn'
import { Clock,Play,Pencil,X,Check,RefreshCw,AlertTriangle } from 'lucide-react'

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatSchedule(s: BeatSchedule): string {
  if (s.schedule_type === 'interval' && s.interval_seconds != null) {
    const sec = s.interval_seconds
    if (sec < 60)  return `Every ${sec}s`
    if (sec < 3600) return `Every ${Math.round(sec / 60)}m`
    return `Every ${Math.round(sec / 3600)}h`
  }
  return s.cron_expression ?? '—'
}

// ── Inline edit row ────────────────────────────────────────────────────────────

function EditRow({
  schedule,
  onSave,
  onCancel,
  saving,
}: {
  schedule: BeatSchedule
  onSave: (val: string) => void
  onCancel: () => void
  saving: boolean
}) {
  const isInterval = schedule.schedule_type === 'interval'
  const [value, setValue] = useState(
    isInterval
      ? String(schedule.interval_seconds ?? '')
      : schedule.cron_expression ?? ''
  )

  return (
    <div className="flex items-center gap-2">
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="h-7 w-40 text-xs"
        placeholder={isInterval ? 'seconds' : 'cron expression'}
      />
      <button
        onClick={() => onSave(value)}
        disabled={saving}
        className="p-1 rounded text-green-400 hover:bg-green-500/10 disabled:opacity-50"
        title="Save"
      >
        <Check className="w-3.5 h-3.5" />
      </button>
      <button
        onClick={onCancel}
        className="p-1 rounded text-muted hover:bg-surface-border"
        title="Cancel"
      >
        <X className="w-3.5 h-3.5" />
      </button>
      {schedule.schedule_type === 'interval' && (
        <span className="text-[10px] text-amber-400 flex items-center gap-1">
          <AlertTriangle className="w-3 h-3" /> restart required
        </span>
      )}
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export function SchedulersTab() {
  const user       = useAuthStore((s) => s.user)
  const isAdmin    = hasPermission(user, 'cardinal', 'admin')
  const queryClient = useQueryClient()

  const [editingKey, setEditingKey] = useState<string | null>(null)

  const { data: schedules, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ['cardinal', 'schedules'],
    queryFn:  () => cardinalApi.schedules().then((r) => r.data),
    staleTime: 30_000,
  })

  const toggleMutation = useMutation({
    mutationFn: ({ taskKey, enabled }: { taskKey: string; enabled: boolean }) =>
      cardinalApi.updateSchedule(taskKey, { enabled }).then((r) => r.data),
    onMutate: async ({ taskKey, enabled }) => {
      // Optimistic update
      await queryClient.cancelQueries({ queryKey: ['cardinal', 'schedules'] })
      const prev = queryClient.getQueryData<BeatSchedule[]>(['cardinal', 'schedules'])
      queryClient.setQueryData<BeatSchedule[]>(['cardinal', 'schedules'], (old) =>
        old?.map((s) => s.task_key === taskKey ? { ...s, enabled } : s) ?? []
      )
      return { prev }
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(['cardinal', 'schedules'], ctx.prev)
      toast.error('Update failed', 'Could not toggle schedule')
    },
    onSuccess: (updated) => {
      queryClient.setQueryData<BeatSchedule[]>(['cardinal', 'schedules'], (old) =>
        old?.map((s) => s.task_key === updated.task_key ? updated : s) ?? []
      )
    },
  })

  const editMutation = useMutation({
    mutationFn: ({ taskKey, patch }: { taskKey: string; patch: { interval_seconds?: number; cron_expression?: string } }) =>
      cardinalApi.updateSchedule(taskKey, patch).then((r) => r.data),
    onSuccess: (updated) => {
      queryClient.setQueryData<BeatSchedule[]>(['cardinal', 'schedules'], (old) =>
        old?.map((s) => s.task_key === updated.task_key ? updated : s) ?? []
      )
      setEditingKey(null)
      toast.success('Schedule updated', 'Changes will apply on next scheduler restart')
    },
    onError: () => toast.error('Update failed', 'Could not update schedule'),
  })

  const triggerMutation = useMutation({
    mutationFn: (taskKey: string) => cardinalApi.triggerSchedule(taskKey).then((r) => r.data),
    onSuccess: (res) => {
      toast.success('Task triggered', res.message)
      // Refresh to get updated last_triggered_at
      queryClient.invalidateQueries({ queryKey: ['cardinal', 'schedules'] })
    },
    onError: () => toast.error('Trigger failed', 'Could not dispatch task to workers'),
  })

  const handleSaveEdit = (schedule: BeatSchedule, value: string) => {
    if (schedule.schedule_type === 'interval') {
      const seconds = parseInt(value, 10)
      if (isNaN(seconds) || seconds < 1) {
        toast.error('Invalid value', 'Interval must be a positive integer (seconds)')
        return
      }
      editMutation.mutate({ taskKey: schedule.task_key, patch: { interval_seconds: seconds } })
    } else {
      if (!value.trim()) {
        toast.error('Invalid value', 'Cron expression cannot be empty')
        return
      }
      editMutation.mutate({ taskKey: schedule.task_key, patch: { cron_expression: value.trim() } })
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Clock className="w-3.5 h-3.5 text-brand-400" />
            Beat Schedules
            <span className="text-xs text-subtle font-normal">
              — {schedules?.length ?? 0} periodic maintenance tasks
            </span>
          </CardTitle>
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="p-1.5 rounded-md text-muted hover:text-foreground hover:bg-surface-border transition-colors disabled:opacity-50"
            title="Refresh"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', isFetching && 'animate-spin')} />
          </button>
        </div>
        <p className="text-xs text-subtle mt-1">
          Enable/disable takes effect on the next beat tick. Interval changes require a scheduler restart.
        </p>
      </CardHeader>

      <CardContent className="p-0">
        {isLoading && (
          <div className="p-4 space-y-2">
            {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-14" />)}
          </div>
        )}

        {isError && (
          <div className="p-6">
            <EmptyState
              icon={<Clock className="w-8 h-8 text-subtle" />}
              title="Could not load schedules"
              description="Ensure the governance service is running."
            />
          </div>
        )}

        {!isLoading && !isError && schedules && (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-border">
                {['Task', 'Schedule', 'Status', 'Last Triggered', 'Actions'].map((h) => (
                  <th
                    key={h}
                    className="px-4 py-2.5 text-left text-xs font-medium text-subtle uppercase tracking-wider"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border">
              {schedules.map((s) => {
                const isEditing       = editingKey === s.task_key
                const isTriggerLoading = triggerMutation.isPending && triggerMutation.variables === s.task_key

                return (
                  <tr key={s.task_key} className="hover:bg-surface-card/50 transition-colors">

                    {/* Task name + description */}
                    <td className="px-4 py-3">
                      <p className="text-xs font-semibold text-foreground">{s.display_name}</p>
                      {s.description && (
                        <p className="text-[10px] text-subtle mt-0.5 max-w-xs line-clamp-1">{s.description}</p>
                      )}
                    </td>

                    {/* Schedule (editable) */}
                    <td className="px-4 py-3">
                      {isEditing ? (
                        <EditRow
                          schedule={s}
                          onSave={(val) => handleSaveEdit(s, val)}
                          onCancel={() => setEditingKey(null)}
                          saving={editMutation.isPending}
                        />
                      ) : (
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs text-foreground">{formatSchedule(s)}</span>
                          {isAdmin && (
                            <button
                              onClick={() => setEditingKey(s.task_key)}
                              className="p-0.5 rounded text-subtle hover:text-foreground hover:bg-surface-border"
                              title="Edit schedule"
                            >
                              <Pencil className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      )}
                    </td>

                    {/* Enable/disable toggle */}
                    <td className="px-4 py-3">
                      <button
                        onClick={() => isAdmin && toggleMutation.mutate({ taskKey: s.task_key, enabled: !s.enabled })}
                        disabled={!isAdmin || toggleMutation.isPending}
                        className={cn(
                          'inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] font-semibold transition-colors',
                          s.enabled
                            ? 'bg-green-500/15 text-green-400 hover:bg-green-500/25'
                            : 'bg-surface-border text-muted hover:bg-surface-border/80',
                          (!isAdmin || toggleMutation.isPending) && 'cursor-default opacity-70',
                        )}
                        title={isAdmin ? (s.enabled ? 'Click to disable' : 'Click to enable') : ''}
                      >
                        <span className={cn(
                          'w-1.5 h-1.5 rounded-full',
                          s.enabled ? 'bg-green-400' : 'bg-muted',
                        )} />
                        {s.enabled ? 'ON' : 'OFF'}
                      </button>
                    </td>

                    {/* Last triggered */}
                    <td className="px-4 py-3 text-xs text-muted">
                      {s.last_triggered_at ? formatDate(s.last_triggered_at) : '—'}
                    </td>

                    {/* Actions */}
                    <td className="px-4 py-3">
                      {isAdmin && (
                        <div className="flex items-center gap-1.5">
                          <Button
                            size="sm"
                            variant="outline"
                            loading={isTriggerLoading}
                            onClick={() => triggerMutation.mutate(s.task_key)}
                            className="h-7 px-2.5 text-xs"
                          >
                            <Play className="w-3 h-3 mr-1" />
                            Run Now
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}

        {/* Updated-by footer */}
        {!isLoading && !isError && schedules?.some((s) => s.updated_by) && (
          <div className="px-4 py-2 border-t border-surface-border">
            <p className="text-[10px] text-subtle">
              Last modified by: {schedules.filter((s) => s.updated_by).map((s) => s.updated_by).join(', ')}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
