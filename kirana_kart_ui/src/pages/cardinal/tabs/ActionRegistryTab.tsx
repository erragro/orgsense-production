import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Textarea } from '@/components/ui/Textarea'
import { Switch } from '@/components/ui/Switch'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { EmptyState } from '@/components/common/EmptyState'
import { cardinalApi } from '@/api/governance/cardinal.api'
import { toast } from '@/stores/toast.store'
import { cn } from '@/lib/cn'
import type { ActionCodeEntry, ActionCodePayload } from '@/types/cardinal.types'
import { Plus, Pencil, Trash2, CheckIcon, XIcon, X, Save } from 'lucide-react'

interface Props {
  canAdmin: boolean
}

const EMPTY_FORM: ActionCodePayload = {
  action_key: '',
  action_code_id: '',
  action_name: '',
  action_description: '',
  freshdesk_status: null,
  freshdesk_status_name: '',
  requires_refund: false,
  requires_escalation: false,
  automation_eligible: true,
}

export function ActionRegistryTab({ canAdmin }: Props) {
  const qc = useQueryClient()
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<ActionCodeEntry | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<ActionCodeEntry | null>(null)

  const { data: codes, isLoading } = useQuery({
    queryKey: ['cardinal', 'action-registry'],
    queryFn: () => cardinalApi.listActionRegistry().then((r) => r.data),
  })

  const createMut = useMutation({
    mutationFn: (p: ActionCodePayload) => cardinalApi.createActionCode(p),
    onSuccess: () => {
      toast.success('Action code created')
      setShowForm(false)
      void qc.invalidateQueries({ queryKey: ['cardinal', 'action-registry'] })
    },
    onError: () => toast.error('Create failed'),
  })

  const updateMut = useMutation({
    mutationFn: ({ id, p }: { id: number; p: Partial<ActionCodePayload> }) =>
      cardinalApi.updateActionCode(id, p),
    onSuccess: () => {
      toast.success('Action code updated')
      setEditing(null)
      void qc.invalidateQueries({ queryKey: ['cardinal', 'action-registry'] })
    },
    onError: () => toast.error('Update failed'),
  })

  const deleteMut = useMutation({
    mutationFn: (id: number) => cardinalApi.deleteActionCode(id),
    onSuccess: () => {
      toast.success('Action code deleted')
      setDeleteTarget(null)
      void qc.invalidateQueries({ queryKey: ['cardinal', 'action-registry'] })
    },
    onError: () => toast.error('Delete failed'),
  })

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-sm font-semibold text-foreground">
          {codes?.length ?? 0} action codes
        </h2>
        {canAdmin && !showForm && !editing && (
          <Button size="sm" onClick={() => setShowForm(true)}>
            <Plus className="w-3.5 h-3.5" />Add Code
          </Button>
        )}
      </div>

      {showForm && (
        <ActionCodeForm
          initial={EMPTY_FORM}
          loading={createMut.isPending}
          onSave={(p) => createMut.mutate(p)}
          onCancel={() => setShowForm(false)}
          title="New Action Code"
        />
      )}

      {editing && (
        <ActionCodeForm
          initial={{
            action_key: editing.action_key,
            action_code_id: editing.action_code_id,
            action_name: editing.action_name,
            action_description: editing.action_description ?? '',
            freshdesk_status: editing.freshdesk_status,
            freshdesk_status_name: editing.freshdesk_status_name ?? '',
            requires_refund: editing.requires_refund,
            requires_escalation: editing.requires_escalation,
            automation_eligible: editing.automation_eligible,
          }}
          loading={updateMut.isPending}
          onSave={(p) => updateMut.mutate({ id: editing.id, p })}
          onCancel={() => setEditing(null)}
          title={`Edit — ${editing.action_code_id}`}
          editMode
        />
      )}

      <Card>
        <CardHeader><CardTitle>Master Action Codes</CardTitle></CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="px-4 py-6 text-sm text-subtle text-center">Loading…</div>
          ) : !codes?.length ? (
            <EmptyState title="No action codes" description="Add the first action code above." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-surface-border">
                    <th className="text-left px-4 py-2 text-subtle font-medium">Code ID</th>
                    <th className="text-left px-4 py-2 text-subtle font-medium">Name</th>
                    <th className="text-left px-4 py-2 text-subtle font-medium hidden lg:table-cell">Description</th>
                    <th className="text-left px-4 py-2 text-subtle font-medium hidden xl:table-cell">FD Status</th>
                    <th className="text-center px-3 py-2 text-subtle font-medium">Refund</th>
                    <th className="text-center px-3 py-2 text-subtle font-medium">Escalate</th>
                    <th className="text-center px-3 py-2 text-subtle font-medium">Auto</th>
                    {canAdmin && <th className="px-4 py-2" />}
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-border">
                  {codes.map((ac) => (
                    <tr key={ac.id} className="hover:bg-surface/50">
                      <td className="px-4 py-2.5">
                        <span className="font-mono text-brand-400">{ac.action_code_id}</span>
                      </td>
                      <td className="px-4 py-2.5 text-foreground">{ac.action_name}</td>
                      <td className="px-4 py-2.5 text-subtle hidden lg:table-cell max-w-xs truncate">
                        {ac.action_description ?? '—'}
                      </td>
                      <td className="px-4 py-2.5 text-subtle hidden xl:table-cell">
                        {ac.freshdesk_status_name
                          ? `${ac.freshdesk_status_name} (${ac.freshdesk_status})`
                          : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-center"><BoolIcon value={ac.requires_refund} /></td>
                      <td className="px-3 py-2.5 text-center"><BoolIcon value={ac.requires_escalation} /></td>
                      <td className="px-3 py-2.5 text-center"><BoolIcon value={ac.automation_eligible} /></td>
                      {canAdmin && (
                        <td className="px-4 py-2.5">
                          <div className="flex gap-2 justify-end">
                            <button
                              onClick={() => setEditing(ac)}
                              className="text-subtle hover:text-foreground transition-colors"
                              title="Edit"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => setDeleteTarget(ac)}
                              className="text-subtle hover:text-red-400 transition-colors"
                              title="Delete"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={deleteTarget != null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && deleteMut.mutate(deleteTarget.id)}
        title={`Delete "${deleteTarget?.action_code_id}"?`}
        description="This will permanently remove the action code. Any rules or templates referencing it may break."
        confirmLabel="Delete"
        loading={deleteMut.isPending}
      />
    </div>
  )
}


// ─── Action Code Form ─────────────────────────────────────────

interface FormProps {
  initial: ActionCodePayload
  loading: boolean
  onSave: (p: ActionCodePayload) => void
  onCancel: () => void
  title: string
  editMode?: boolean
}

function ActionCodeForm({ initial, loading, onSave, onCancel, title, editMode }: FormProps) {
  const [form, setForm] = useState<ActionCodePayload>({ ...initial })

  const set = (key: keyof ActionCodePayload, value: unknown) =>
    setForm((prev) => ({ ...prev, [key]: value }))

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSave(form)
  }

  return (
    <Card className={cn('border border-brand-500/30')}>
      <CardHeader>
        <div className="flex justify-between items-center">
          <CardTitle>{title}</CardTitle>
          <button onClick={onCancel} className="text-subtle hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input
              label="Code ID *"
              placeholder="REFUND_FULL"
              value={form.action_code_id}
              onChange={(e) => set('action_code_id', e.target.value.toUpperCase())}
              required
              disabled={editMode}
            />
            <Input
              label="Action Key *"
              placeholder="refund-full"
              value={form.action_key}
              onChange={(e) => set('action_key', e.target.value)}
              required
            />
          </div>
          <Input
            label="Action Name *"
            placeholder="Full Refund Issued"
            value={form.action_name}
            onChange={(e) => set('action_name', e.target.value)}
            required
          />
          <Textarea
            label="Description"
            placeholder="One-sentence description of when this action applies"
            className="min-h-[72px]"
            value={form.action_description ?? ''}
            onChange={(e) => set('action_description', e.target.value || null)}
          />
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Freshdesk Status ID"
              type="number"
              placeholder="5"
              value={form.freshdesk_status ?? ''}
              onChange={(e) => set('freshdesk_status', e.target.value ? Number(e.target.value) : null)}
            />
            <Input
              label="Freshdesk Status Name"
              placeholder="Refunded"
              value={form.freshdesk_status_name ?? ''}
              onChange={(e) => set('freshdesk_status_name', e.target.value || null)}
            />
          </div>
          <div className="flex flex-wrap gap-6 pt-1">
            <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
              <Switch
                checked={form.requires_refund ?? false}
                onCheckedChange={(v) => set('requires_refund', v)}
              />
              Requires Refund
            </label>
            <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
              <Switch
                checked={form.requires_escalation ?? false}
                onCheckedChange={(v) => set('requires_escalation', v)}
              />
              Requires Escalation
            </label>
            <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
              <Switch
                checked={form.automation_eligible ?? true}
                onCheckedChange={(v) => set('automation_eligible', v)}
              />
              Automation Eligible
            </label>
          </div>
          <div className="flex gap-2 justify-end pt-1">
            <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
            <Button type="submit" loading={loading}>
              <Save className="w-3.5 h-3.5" />{editMode ? 'Save Changes' : 'Create'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

function BoolIcon({ value }: { value: boolean }) {
  return value
    ? <CheckIcon className="w-3.5 h-3.5 mx-auto text-green-400" />
    : <XIcon className="w-3.5 h-3.5 mx-auto text-subtle" />
}
