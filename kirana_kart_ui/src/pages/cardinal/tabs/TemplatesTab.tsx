import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Textarea } from '@/components/ui/Textarea'
import { Select } from '@/components/ui/Select'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { EmptyState } from '@/components/common/EmptyState'
import { cardinalApi } from '@/api/governance/cardinal.api'
import { toast } from '@/stores/toast.store'
import { cn } from '@/lib/cn'
import type { ResponseTemplate, TemplatePayload } from '@/types/cardinal.types'
import { Plus, Pencil, Trash2, ChevronDown, ChevronRight, X, Save } from 'lucide-react'

interface Props {
  canAdmin: boolean
}

const EMPTY_FORM: TemplatePayload = {
  template_ref: '',
  action_code_id: null,
  issue_l1: null,
  issue_l2: null,
  template_v1: null,
  template_v2: null,
  template_v3: null,
  template_v4: null,
  template_v5: null,
}

export function TemplatesTab({ canAdmin }: Props) {
  const qc = useQueryClient()
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<ResponseTemplate | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<ResponseTemplate | null>(null)
  const [expandedId, setExpandedId] = useState<number | null>(null)

  const { data: templates, isLoading } = useQuery({
    queryKey: ['cardinal', 'templates'],
    queryFn: () => cardinalApi.listTemplates().then((r) => r.data),
  })

  const { data: actionCodes } = useQuery({
    queryKey: ['cardinal', 'action-registry'],
    queryFn: () => cardinalApi.listActionRegistry().then((r) => r.data),
  })

  const createMut = useMutation({
    mutationFn: (p: TemplatePayload) => cardinalApi.createTemplate(p),
    onSuccess: () => {
      toast.success('Template created')
      setShowForm(false)
      void qc.invalidateQueries({ queryKey: ['cardinal', 'templates'] })
    },
    onError: () => toast.error('Create failed'),
  })

  const updateMut = useMutation({
    mutationFn: ({ id, p }: { id: number; p: Partial<TemplatePayload> }) =>
      cardinalApi.updateTemplate(id, p),
    onSuccess: () => {
      toast.success('Template updated')
      setEditing(null)
      void qc.invalidateQueries({ queryKey: ['cardinal', 'templates'] })
    },
    onError: () => toast.error('Update failed'),
  })

  const deleteMut = useMutation({
    mutationFn: (id: number) => cardinalApi.deleteTemplate(id),
    onSuccess: () => {
      toast.success('Template deleted')
      setDeleteTarget(null)
      void qc.invalidateQueries({ queryKey: ['cardinal', 'templates'] })
    },
    onError: () => toast.error('Delete failed'),
  })

  const codeOptions = [
    { value: '', label: 'None' },
    ...(actionCodes ?? []).map((ac) => ({
      value: ac.action_code_id,
      label: `${ac.action_code_id} — ${ac.action_name}`,
    })),
  ]

  const variantCount = (t: ResponseTemplate) =>
    [t.template_v1, t.template_v2, t.template_v3, t.template_v4, t.template_v5].filter(Boolean).length

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-sm font-semibold text-foreground">
          {templates?.length ?? 0} template{templates?.length !== 1 ? 's' : ''}
        </h2>
        {canAdmin && !showForm && !editing && (
          <Button size="sm" onClick={() => setShowForm(true)}>
            <Plus className="w-3.5 h-3.5" />Add Template
          </Button>
        )}
      </div>

      {showForm && (
        <TemplateForm
          initial={EMPTY_FORM}
          codeOptions={codeOptions}
          loading={createMut.isPending}
          onSave={(p) => createMut.mutate(p)}
          onCancel={() => setShowForm(false)}
          title="New Template"
        />
      )}

      {editing && (
        <TemplateForm
          initial={{
            template_ref: editing.template_ref,
            action_code_id: editing.action_code_id,
            issue_l1: editing.issue_l1,
            issue_l2: editing.issue_l2,
            template_v1: editing.template_v1,
            template_v2: editing.template_v2,
            template_v3: editing.template_v3,
            template_v4: editing.template_v4,
            template_v5: editing.template_v5,
          }}
          codeOptions={codeOptions}
          loading={updateMut.isPending}
          onSave={(p) => updateMut.mutate({ id: editing.id, p })}
          onCancel={() => setEditing(null)}
          title={`Edit — ${editing.template_ref}`}
        />
      )}

      <Card>
        <CardHeader><CardTitle>Response Templates</CardTitle></CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="px-4 py-6 text-sm text-subtle text-center">Loading…</div>
          ) : !templates?.length ? (
            <EmptyState
              title="No templates yet"
              description="Add response templates to link them with action codes."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-surface-border">
                    <th className="w-6 px-2 py-2" />
                    <th className="text-left px-4 py-2 text-subtle font-medium">Template Ref</th>
                    <th className="text-left px-4 py-2 text-subtle font-medium">Action Code</th>
                    <th className="text-left px-4 py-2 text-subtle font-medium hidden sm:table-cell">Issue L1</th>
                    <th className="text-left px-4 py-2 text-subtle font-medium hidden md:table-cell">Issue L2</th>
                    <th className="text-center px-3 py-2 text-subtle font-medium">Variants</th>
                    {canAdmin && <th className="px-4 py-2" />}
                  </tr>
                </thead>
                <tbody>
                  {templates.map((t) => (
                    <TemplateRow
                      key={t.id}
                      template={t}
                      variantCount={variantCount(t)}
                      expanded={expandedId === t.id}
                      onToggle={() => setExpandedId(expandedId === t.id ? null : t.id)}
                      canAdmin={canAdmin}
                      onEdit={() => setEditing(t)}
                      onDelete={() => setDeleteTarget(t)}
                    />
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
        title={`Delete "${deleteTarget?.template_ref}"?`}
        description="This will permanently remove the template and all its variant text."
        confirmLabel="Delete"
        loading={deleteMut.isPending}
      />
    </div>
  )
}


// ─── Template Row ─────────────────────────────────────────────

function TemplateRow({
  template,
  variantCount,
  expanded,
  onToggle,
  canAdmin,
  onEdit,
  onDelete,
}: {
  template: ResponseTemplate
  variantCount: number
  expanded: boolean
  onToggle: () => void
  canAdmin: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  const variants = [
    template.template_v1,
    template.template_v2,
    template.template_v3,
    template.template_v4,
    template.template_v5,
  ]

  return (
    <>
      <tr
        className={cn(
          'border-b border-surface-border cursor-pointer hover:bg-surface/50 transition-colors',
          expanded && 'bg-surface/30'
        )}
        onClick={onToggle}
      >
        <td className="w-6 px-2 py-2.5 text-subtle">
          {variantCount > 0
            ? expanded
              ? <ChevronDown className="w-3.5 h-3.5" />
              : <ChevronRight className="w-3.5 h-3.5" />
            : null}
        </td>
        <td className="px-4 py-2.5 font-medium text-foreground">{template.template_ref}</td>
        <td className="px-4 py-2.5">
          {template.action_code_id
            ? <span className="font-mono text-brand-400">{template.action_code_id}</span>
            : <span className="text-subtle">—</span>}
        </td>
        <td className="px-4 py-2.5 text-subtle hidden sm:table-cell">{template.issue_l1 ?? '—'}</td>
        <td className="px-4 py-2.5 text-subtle hidden md:table-cell">{template.issue_l2 ?? '—'}</td>
        <td className="px-3 py-2.5 text-center">
          <span className={cn(
            'inline-flex items-center justify-center w-5 h-5 rounded-full text-xs font-semibold',
            variantCount > 0 ? 'bg-brand-500/20 text-brand-400' : 'bg-surface text-subtle'
          )}>
            {variantCount}
          </span>
        </td>
        {canAdmin && (
          <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
            <div className="flex gap-2 justify-end">
              <button
                onClick={onEdit}
                className="text-subtle hover:text-foreground transition-colors"
                title="Edit"
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={onDelete}
                className="text-subtle hover:text-red-400 transition-colors"
                title="Delete"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </td>
        )}
      </tr>

      {expanded && variantCount > 0 && (
        <tr className="border-b border-surface-border bg-surface/20">
          <td />
          <td colSpan={canAdmin ? 5 : 4} className="px-4 py-3">
            <div className="space-y-3">
              {variants.map((v, i) =>
                v ? (
                  <div key={i}>
                    <p className="text-xs text-subtle mb-1 font-medium">Variant {i + 1}</p>
                    <pre className="text-xs font-mono bg-surface rounded p-2 overflow-auto text-foreground whitespace-pre-wrap max-h-40">
                      {v}
                    </pre>
                  </div>
                ) : null
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}


// ─── Template Form ────────────────────────────────────────────

function TemplateForm({
  initial,
  codeOptions,
  loading,
  onSave,
  onCancel,
  title,
}: {
  initial: TemplatePayload
  codeOptions: { value: string; label: string }[]
  loading: boolean
  onSave: (p: TemplatePayload) => void
  onCancel: () => void
  title: string
}) {
  const [form, setForm] = useState<TemplatePayload>({ ...initial })

  const set = (key: keyof TemplatePayload, value: unknown) =>
    setForm((prev) => ({ ...prev, [key]: value }))

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSave(form)
  }

  const variantKeys: (keyof TemplatePayload)[] = [
    'template_v1', 'template_v2', 'template_v3', 'template_v4', 'template_v5',
  ]

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
          <Input
            label="Template Ref *"
            placeholder="REFUND_FULL_EMAIL_EN"
            value={form.template_ref}
            onChange={(e) => set('template_ref', e.target.value)}
            required
          />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Select
              label="Action Code"
              options={codeOptions}
              value={form.action_code_id ?? ''}
              onChange={(e) => set('action_code_id', e.target.value || null)}
            />
            <Input
              label="Issue L1"
              placeholder="e.g. delivery"
              value={form.issue_l1 ?? ''}
              onChange={(e) => set('issue_l1', e.target.value || null)}
            />
            <Input
              label="Issue L2"
              placeholder="e.g. late_delivery"
              value={form.issue_l2 ?? ''}
              onChange={(e) => set('issue_l2', e.target.value || null)}
            />
          </div>

          <div className="border-t border-surface-border pt-3">
            <p className="text-xs text-subtle mb-3">
              Template Variants — enter at least one. Each variant is an alternative phrasing of the same response.
            </p>
            <div className="space-y-3">
              {variantKeys.map((key, i) => (
                <Textarea
                  key={key}
                  label={`Variant ${i + 1}`}
                  placeholder={`Response variant ${i + 1}…`}
                  className="min-h-[80px] font-mono text-xs"
                  value={(form[key] as string | null) ?? ''}
                  onChange={(e) => set(key, e.target.value || null)}
                />
              ))}
            </div>
          </div>

          <div className="flex gap-2 justify-end pt-1">
            <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
            <Button type="submit" loading={loading}>
              <Save className="w-3.5 h-3.5" />Save Template
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
