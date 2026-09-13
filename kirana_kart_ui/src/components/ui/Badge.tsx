import { cn } from '@/lib/cn'

export interface BadgeProps {
  children: React.ReactNode
  variant?: 'green' | 'red' | 'amber' | 'blue' | 'purple' | 'gray' | 'outline'
  size?: 'sm' | 'md'
  className?: string
}

const variantStyles: Record<NonNullable<BadgeProps['variant']>, string> = {
  green:  'bg-green-100  text-green-700  border-green-300  dark:bg-green-900/40  dark:text-green-300  dark:border-green-700/50',
  red:    'bg-red-100    text-red-700    border-red-300    dark:bg-red-900/40    dark:text-red-300    dark:border-red-700/50',
  amber:  'bg-amber-100  text-amber-700  border-amber-300  dark:bg-amber-900/40  dark:text-amber-300  dark:border-amber-700/50',
  blue:   'bg-blue-100   text-blue-700   border-blue-300   dark:bg-blue-900/40   dark:text-blue-300   dark:border-blue-700/50',
  purple: 'bg-purple-100 text-purple-700 border-purple-300 dark:bg-purple-900/40 dark:text-purple-300 dark:border-purple-700/50',
  gray:   'bg-slate-100  text-slate-600  border-slate-300  dark:bg-slate-700/50  dark:text-slate-300  dark:border-slate-600',
  outline: 'bg-transparent text-muted border-surface-border',
}

const sizeStyles: Record<NonNullable<BadgeProps['size']>, string> = {
  sm: 'px-1.5 py-0.5 text-xs',
  md: 'px-2 py-1 text-xs',
}

export function Badge({ children, variant = 'gray', size = 'sm', className }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center font-medium rounded border',
        variantStyles[variant],
        sizeStyles[size],
        className
      )}
    >
      {children}
    </span>
  )
}
