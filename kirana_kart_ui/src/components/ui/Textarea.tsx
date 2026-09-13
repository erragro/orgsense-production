import { forwardRef } from 'react'
import { cn } from '@/lib/cn'

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: string
  label?: string
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, error, label, id, ...props }, ref) => (
    <div className="flex flex-col gap-1">
      {label && (
        <label htmlFor={id} className="text-xs font-medium text-muted">
          {label}
        </label>
      )}
      <textarea
        ref={ref}
        id={id}
        className={cn(
          'w-full bg-surface border border-surface-border rounded-md px-3 py-2 text-sm text-foreground',
          'placeholder:text-subtle resize-y min-h-[80px]',
          'focus:outline-none focus:ring-1 focus:ring-brand-500 focus:border-brand-500',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          error && 'border-red-500 focus:ring-red-500',
          className
        )}
        {...props}
      />
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  )
)
Textarea.displayName = 'Textarea'
