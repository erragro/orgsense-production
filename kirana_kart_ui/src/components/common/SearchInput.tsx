import { useState, useEffect, useRef } from 'react'
import { Search, X } from 'lucide-react'
import { cn } from '@/lib/cn'

interface SearchInputProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  debounceMs?: number
  className?: string
}

export function SearchInput({ value, onChange, placeholder = 'Search…', debounceMs = 300, className }: SearchInputProps) {
  const [local, setLocal] = useState(value)
  // Keep a stable ref so the debounce effect doesn't re-fire when the parent
  // re-renders and passes a new inline arrow function as onChange.
  const onChangeRef = useRef(onChange)
  useEffect(() => { onChangeRef.current = onChange })

  useEffect(() => {
    setLocal(value)
  }, [value])

  useEffect(() => {
    const timer = setTimeout(() => onChangeRef.current(local), debounceMs)
    return () => clearTimeout(timer)
  }, [local, debounceMs]) // onChange intentionally omitted — use ref above

  return (
    <div className={cn('relative flex-1', className)}>
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-subtle" />
      <input
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-surface border border-surface-border rounded-md pl-9 pr-8 py-2 text-sm text-foreground placeholder:text-subtle focus:outline-none focus:ring-1 focus:ring-brand-500"
      />
      {local && (
        <button
          onClick={() => { setLocal(''); onChange('') }}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-foreground"
        >
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  )
}
