import { useLocation } from 'react-router-dom'
import { Sun, Moon } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useUIStore } from '@/stores/ui.store'
import { useAuthStore } from '@/stores/auth.store'
import { hasPermission } from '@/lib/access'
import { NotificationBell } from '@/pages/crm/components/NotificationBell'
import { KBContextSelector } from './KBContextSelector'

const BREADCRUMB_MAP: Record<string, string> = {
  '/dashboard': 'Dashboard',
  '/tickets': 'Tickets',
  '/taxonomy': 'Taxonomy',
  '/knowledge-base': 'Knowledge Base',
  '/policy': 'Policy',
  '/customers': 'Customers',
  '/analytics': 'Analytics',
  '/system': 'System Admin',
  '/bi-agent': 'BI Agent',
}

interface TopBarProps {
  systemHealthStatus?: 'healthy' | 'degraded' | 'unhealthy'
}

const healthDotColors = {
  healthy: 'bg-green-400',
  degraded: 'bg-amber-400',
  unhealthy: 'bg-red-400',
}

export function TopBar({ systemHealthStatus }: TopBarProps) {
  const { pathname } = useLocation()
  const { theme, toggleTheme } = useUIStore()
  const { user } = useAuthStore()
  const hasCRM = hasPermission(user, 'crm', 'view')

  // Derive breadcrumb
  const segments = pathname.split('/').filter(Boolean)
  const topRoute = '/' + (segments[0] ?? '')
  const breadcrumb = BREADCRUMB_MAP[topRoute] ?? segments.map((s) => s.replace(/-/g, ' ')).join(' / ')

  return (
    <header className="h-14 border-b border-surface-border bg-surface/80 backdrop-blur flex items-center justify-between px-4 sticky top-0 z-20">
      <nav className="flex items-center gap-2 text-sm">
        <span className="text-subtle">Auralis</span>
        <span className="text-subtle opacity-60">/</span>
        <span className="text-foreground font-medium capitalize">{breadcrumb}</span>
        {segments[1] && (
          <>
            <span className="text-subtle opacity-60">/</span>
            <span className="text-muted font-mono text-xs">{segments[1]}</span>
          </>
        )}
      </nav>

      <div className="flex items-center gap-3">
        <KBContextSelector />
        {hasCRM && <NotificationBell />}
        {systemHealthStatus && (
          <div className="flex items-center gap-1.5">
            <span className={cn('w-2 h-2 rounded-full', healthDotColors[systemHealthStatus])} />
            <span className="text-xs text-muted capitalize">{systemHealthStatus}</span>
          </div>
        )}

        {/* Theme toggle */}
        <button
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          className="flex items-center justify-center w-8 h-8 rounded-md text-muted hover:text-foreground hover:bg-surface-card border border-transparent hover:border-surface-border transition-colors"
        >
          {theme === 'dark' ? (
            <Sun className="w-4 h-4" />
          ) : (
            <Moon className="w-4 h-4" />
          )}
        </button>
      </div>
    </header>
  )
}
