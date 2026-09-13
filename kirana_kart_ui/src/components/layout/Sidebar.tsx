import { NavLink, useNavigate } from 'react-router-dom'
import { cn } from '@/lib/cn'
import { useUIStore } from '@/stores/ui.store'
import { useAuthStore } from '@/stores/auth.store'
import {
  LayoutDashboard, Ticket, TreeDeciduous,
  BookOpen, Shield, Users, BarChart3, Settings,
  ChevronLeft, ChevronRight, LogOut, BrainCircuit, FlaskConical, UserCog, Cpu, ShieldCheck,
  Headphones, ListChecks, BarChart2, FileBarChart2, Zap, Clock, GitBranch, Database,
  type LucideIcon,
} from 'lucide-react'
import { hasPermission, type AppModule, type Permission } from '@/lib/access'
import type { User } from '@/stores/auth.store'

interface NavItem {
  label: string
  icon: LucideIcon
  path: string
  module: AppModule
  permission?: Permission
  highlight?: boolean
}

interface NavGroup {
  label: string
  items: NavItem[]
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Operations',
    items: [
      { label: 'Dashboard', icon: LayoutDashboard, path: '/dashboard', module: 'dashboard' },
      { label: 'Tickets', icon: Ticket, path: '/tickets', module: 'tickets' },
      { label: 'Sandbox', icon: FlaskConical, path: '/sandbox', module: 'sandbox' },
    ],
  },
  {
    label: 'Governance',
    items: [
      { label: 'Taxonomy', icon: TreeDeciduous, path: '/taxonomy', module: 'taxonomy' },
      { label: 'Knowledge Base', icon: BookOpen, path: '/knowledge-base', module: 'knowledgeBase' },
      { label: 'Policy', icon: Shield, path: '/policy', module: 'policy' },
      { label: 'Policy BPM', icon: GitBranch, path: '/policy/bpm', module: 'policy' },
    ],
  },
  {
    label: 'Customer Intelligence',
    items: [
      { label: 'Customers', icon: Users, path: '/customers', module: 'customers' },
      { label: 'Analytics', icon: BarChart3, path: '/analytics', module: 'analytics' },
    ],
  },
  {
    label: 'Intelligence',
    items: [
      { label: 'Cardinal',  icon: Cpu,          path: '/cardinal',  module: 'cardinal' },
      { label: 'BI Agent',  icon: BrainCircuit, path: '/bi-agent',  module: 'biAgent' },
      { label: 'QA Agent',  icon: ShieldCheck,  path: '/qa-agent',  module: 'qaAgent' },
    ],
  },
  {
    label: 'CRM',
    items: [
      { label: 'Queue',          icon: Headphones,    path: '/crm',               module: 'crm' as AppModule },
      { label: 'My Dashboard',   icon: ListChecks,    path: '/crm/dashboard',     module: 'crm' as AppModule },
      { label: 'Team Dashboard', icon: BarChart2,     path: '/crm/admin',         module: 'crm' as AppModule, permission: 'admin' as Permission },
      { label: 'Groups',         icon: Users,         path: '/crm/groups',        module: 'crm' as AppModule, permission: 'admin' as Permission },
      { label: 'Automation',     icon: Zap,           path: '/crm/automation',    module: 'crm' as AppModule, permission: 'admin' as Permission },
      { label: 'SLA Policies',   icon: Clock,         path: '/crm/sla-policies',  module: 'crm' as AppModule, permission: 'admin' as Permission },
      { label: 'Reports',        icon: FileBarChart2, path: '/crm/reports',       module: 'crm' as AppModule, permission: 'admin' as Permission },
    ],
  },
  {
    label: 'System',
    items: [
      { label: 'System Admin', icon: Settings, path: '/system', module: 'system' },
      { label: 'Users', icon: UserCog, path: '/users', module: 'system', permission: 'admin' },
      { label: 'KB Admin', icon: Database, path: '/admin/kbs', module: 'system', permission: 'admin' },
    ],
  },
]

function isItemVisible(user: User | null, item: NavItem): boolean {
  return hasPermission(user, item.module, item.permission ?? 'view')
}

export function Sidebar() {
  const { sidebarCollapsed, toggleSidebar } = useUIStore()
  const { user, logout } = useAuthStore()
  const navigate = useNavigate()

  const handleLogout = () => {
    logout()
    navigate('/login')
  }

  return (
    <aside
      className={cn(
        'flex flex-col bg-surface-card border-r border-surface-border h-screen sticky top-0 transition-all duration-200',
        sidebarCollapsed ? 'w-14' : 'w-56'
      )}
    >
      {/* Logo */}
      <div className="flex items-center gap-2 px-4 py-4 border-b border-surface-border min-h-[56px]">
        <div className="w-7 h-7 rounded bg-brand-600 flex items-center justify-center shrink-0">
          <span className="text-white text-xs font-bold">KK</span>
        </div>
        {!sidebarCollapsed && (
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground truncate">Auralis</p>
            <p className="text-xs text-subtle truncate">CX Operations Platform</p>
          </div>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-3 px-2">
        {NAV_GROUPS.map((group) => {
          const visibleItems = group.items.filter((item) => isItemVisible(user, item))
          if (!visibleItems.length) return null
          return (
          <div key={group.label} className="mb-4">
            {!sidebarCollapsed && (
              <p className="text-xs font-semibold text-subtle uppercase tracking-wider px-2 mb-1">
                {group.label}
              </p>
            )}
            {visibleItems.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-2.5 px-2 py-2 rounded-md text-sm transition-colors mb-0.5',
                    isActive
                      ? 'bg-brand-600/20 text-brand-400 border border-brand-600/30'
                      : 'text-muted hover:text-foreground hover:bg-surface',
                    item.highlight && !sidebarCollapsed && 'ring-1 ring-brand-600/30'
                  )
                }
              >
                <item.icon className={cn('w-4 h-4 shrink-0', item.highlight && 'text-brand-500')} />
                {!sidebarCollapsed && (
                  <span className="truncate">{item.label}</span>
                )}
                {item.highlight && !sidebarCollapsed && (
                  <span className="ml-auto text-xs bg-brand-600 text-white px-1 py-0.5 rounded">
                    Demo
                  </span>
                )}
              </NavLink>
            ))}
          </div>
          )
        })}
      </nav>

      {/* Footer */}
      <div className="border-t border-surface-border p-2 space-y-1">
        {!sidebarCollapsed && user && (
          <div className="px-2 py-1.5 bg-surface rounded-md mb-2">
            <p className="text-xs text-subtle truncate">{user.email}</p>
            <p className="text-xs font-medium text-foreground truncate">{user.full_name || user.email}</p>
            {user.is_super_admin && (
              <p className="text-xs text-brand-500">Super Admin</p>
            )}
          </div>
        )}
        <button
          onClick={handleLogout}
          className="flex items-center gap-2 w-full px-2 py-2 text-sm text-muted hover:text-red-500 rounded-md hover:bg-surface transition-colors"
        >
          <LogOut className="w-4 h-4 shrink-0" />
          {!sidebarCollapsed && 'Sign Out'}
        </button>
        <button
          onClick={toggleSidebar}
          className="flex items-center gap-2 w-full px-2 py-2 text-sm text-subtle hover:text-foreground rounded-md hover:bg-surface transition-colors"
        >
          {sidebarCollapsed ? (
            <ChevronRight className="w-4 h-4 shrink-0" />
          ) : (
            <>
              <ChevronLeft className="w-4 h-4 shrink-0" />
              <span>Collapse</span>
            </>
          )}
        </button>
      </div>
    </aside>
  )
}
