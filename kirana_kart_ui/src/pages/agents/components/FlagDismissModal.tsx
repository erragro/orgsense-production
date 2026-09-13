/**
 * FlagDismissModal — lets governance admins dismiss a Six Sigma or ML QA flag.
 *
 * Requires: policy.admin permission (enforced on the server).
 * Records: dismiss_reason + optional note → qa_flag_overrides table.
 */

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { X, ShieldCheck, Loader2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { qaApi } from '@/api/governance/qa.api'

const DISMISS_REASONS = [
  'Expected behavior',
  'Business exception',
  'False positive',
] as const

interface Props {
  evaluationId: number
  parameterName: string
  originalScore: number
  onClose: () => void
}

export function FlagDismissModal({ evaluationId, parameterName, originalScore, onClose }: Props) {
  const qc = useQueryClient()
  const [reason, setReason] = useState<string>(DISMISS_REASONS[0])
  const [note, setNote] = useState('')

  const dismiss = useMutation({
    mutationFn: () =>
      qaApi.dismissFlag(evaluationId, {
        parameter_name: parameterName,
        original_score: originalScore,
        dismiss_reason: reason,
        dismiss_note: note,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['qa-flags', evaluationId] })
      onClose()
    },
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative w-full max-w-md rounded-xl border border-surface-border bg-surface-card shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-surface-border">
          <div className="flex items-center gap-2.5">
            <ShieldCheck className="w-4 h-4 text-amber-400" />
            <h2 className="text-sm font-semibold text-foreground">Dismiss Flag</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-muted hover:text-foreground hover:bg-surface-border transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          {/* Which check */}
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
            <p className="text-xs text-muted">Dismissing flag for:</p>
            <p className="text-sm font-medium text-foreground mt-0.5">{parameterName}</p>
            <p className="text-xs text-amber-400 mt-0.5">
              Score: {Math.round(originalScore * 100)}% — below 60% threshold
            </p>
          </div>

          {/* Reason picker */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">Why are you dismissing this?</label>
            <div className="space-y-2">
              {DISMISS_REASONS.map(r => (
                <label key={r} className="flex items-center gap-2.5 cursor-pointer group">
                  <div className={cn(
                    'w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors',
                    reason === r
                      ? 'border-brand-500 bg-brand-500'
                      : 'border-surface-border group-hover:border-brand-400',
                  )}>
                    {reason === r && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                  </div>
                  <input
                    type="radio"
                    name="dismiss_reason"
                    value={r}
                    checked={reason === r}
                    onChange={() => setReason(r)}
                    className="sr-only"
                  />
                  <span className="text-sm text-foreground">{r}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Optional note */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">
              Additional notes <span className="text-muted">(optional)</span>
            </label>
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="e.g. This customer is a VIP account — behaviour is expected…"
              rows={3}
              className="w-full rounded-lg border border-surface-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-subtle resize-none focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>

          {dismiss.isError && (
            <p className="text-xs text-red-400">Failed to dismiss flag. Please try again.</p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-surface-border">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm text-muted hover:text-foreground hover:bg-surface-border transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => dismiss.mutate()}
            disabled={dismiss.isPending}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-amber-500 hover:bg-amber-400 text-white transition-colors disabled:opacity-50"
          >
            {dismiss.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Confirm Dismiss
          </button>
        </div>
      </div>
    </div>
  )
}
