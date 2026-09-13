import { useEffect } from 'react'
import { useToastStore, type Toast } from '@/stores/toast.store'
import { cn } from '@/lib/cn'
import { X, CheckCircle, AlertCircle, AlertTriangle, Info } from 'lucide-react'

const iconMap = {
  success: <CheckCircle className="w-4 h-4 text-green-400" />,
  error: <AlertCircle className="w-4 h-4 text-red-400" />,
  warning: <AlertTriangle className="w-4 h-4 text-amber-400" />,
  info: <Info className="w-4 h-4 text-blue-400" />,
}

const borderMap = {
  success: 'border-green-400 dark:border-green-700/50',
  error:   'border-red-400   dark:border-red-700/50',
  warning: 'border-amber-400 dark:border-amber-700/50',
  info:    'border-blue-400  dark:border-blue-700/50',
}

function ToastItem({ toast, onRemove }: { toast: Toast; onRemove: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onRemove, 4000)
    return () => clearTimeout(timer)
  }, [onRemove])

  return (
    <div
      className={cn(
        'flex items-start gap-3 bg-surface-card border rounded-lg p-3 shadow-lg min-w-72 max-w-sm',
        borderMap[toast.type]
      )}
    >
      <span className="mt-0.5 shrink-0">{iconMap[toast.type]}</span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground">{toast.title}</p>
        {toast.description && (
          <p className="text-xs text-muted mt-0.5">{toast.description}</p>
        )}
      </div>
      <button onClick={onRemove} className="shrink-0 text-subtle hover:text-foreground">
        <X className="w-4 h-4" />
      </button>
    </div>
  )
}

export function Toaster() {
  const { toasts, removeToast } = useToastStore()

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onRemove={() => removeToast(t.id)} />
      ))}
    </div>
  )
}
