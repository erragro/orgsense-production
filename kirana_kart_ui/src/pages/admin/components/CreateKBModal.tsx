import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { X, Database } from 'lucide-react'
import { cn } from '@/lib/cn'
import { bpmApi } from '@/api/governance/bpm.api'
import { useKBStore } from '@/stores/kb.store'

interface Props {
  onClose: () => void
}

export function CreateKBModal({ onClose }: Props) {
  const qc = useQueryClient()
  const { setActiveKbId } = useKBStore()
  const [kbId, setKbId] = useState('')
  const [kbName, setKbName] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)

  const create = useMutation({
    mutationFn: () => bpmApi.createKB({ kb_id: kbId.trim(), kb_name: kbName.trim(), description: description.trim() || undefined }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['bpm', 'kbs'] })
      setActiveKbId(res.data.kb_id)
      onClose()
    },
    onError: (e: unknown) => {
      setError(e instanceof Error ? e.message : 'Failed to create KB')
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!kbId.trim() || !kbName.trim()) {
      setError('KB ID and Name are required')
      return
    }
    create.mutate()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-surface-card border border-surface-border rounded-xl shadow-xl w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <Database className="w-5 h-5 text-brand-500" />
            <h2 className="text-lg font-semibold text-foreground">Create Knowledge Base</h2>
          </div>
          <button onClick={onClose} className="text-muted hover:text-foreground transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              KB ID <span className="text-red-500">*</span>
            </label>
            <input
              value={kbId}
              onChange={(e) => setKbId(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''))}
              placeholder="e.g. food_delivery"
              className={cn(
                'w-full px-3 py-2 rounded-lg border text-sm',
                'bg-surface border-surface-border text-foreground',
                'placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-brand-500',
              )}
            />
            <p className="mt-1 text-xs text-muted">Lowercase letters, numbers, underscores only. Cannot be changed later.</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Display Name <span className="text-red-500">*</span>
            </label>
            <input
              value={kbName}
              onChange={(e) => setKbName(e.target.value)}
              placeholder="e.g. Food Delivery"
              className={cn(
                'w-full px-3 py-2 rounded-lg border text-sm',
                'bg-surface border-surface-border text-foreground',
                'placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-brand-500',
              )}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-1">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="Optional description..."
              className={cn(
                'w-full px-3 py-2 rounded-lg border text-sm resize-none',
                'bg-surface border-surface-border text-foreground',
                'placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-brand-500',
              )}
            />
          </div>

          {error && (
            <p className="text-sm text-red-500 bg-red-50 dark:bg-red-900/20 px-3 py-2 rounded-lg">{error}</p>
          )}

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 text-sm rounded-lg border border-surface-border text-foreground hover:bg-surface transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={create.isPending}
              className="flex-1 px-4 py-2 text-sm rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50 transition-colors font-medium"
            >
              {create.isPending ? 'Creating...' : 'Create KB'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
