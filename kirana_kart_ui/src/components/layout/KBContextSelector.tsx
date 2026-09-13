/**
 * KBContextSelector
 *
 * Global dropdown in the TopBar that lets users switch between Knowledge Bases
 * they have access to. Super admins also see a "Create New KB" option.
 *
 * Automatically loads accessible KBs on mount and stores the selection in
 * kb.store (persisted to localStorage).
 */

import { useEffect, useState } from 'react'
import { ChevronDown, Database, Plus, Check } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'

import { cn } from '@/lib/cn'
import { useAuthStore } from '@/stores/auth.store'
import { useKBStore } from '@/stores/kb.store'
import { bpmApi } from '@/api/governance/bpm.api'
import { hasPermission } from '@/lib/access'
import { CreateKBModal } from '@/pages/admin/components/CreateKBModal'

export function KBContextSelector() {
  const { user } = useAuthStore()
  const { activeKbId, setActiveKbId, setAccessibleKBs, accessibleKBs } = useKBStore()
  const [showCreate, setShowCreate] = useState(false)

  const canManageKBs = user?.is_super_admin || hasPermission(user, 'system', 'admin')

  // Load accessible KBs
  const { data: kbs } = useQuery({
    queryKey: ['bpm', 'kbs'],
    queryFn: () => bpmApi.listKBs().then((r) => r.data),
    staleTime: 60_000,
    enabled: !!user,
  })

  useEffect(() => {
    if (kbs) setAccessibleKBs(kbs)
  }, [kbs, setAccessibleKBs])

  const activeKB = accessibleKBs.find((kb) => kb.kb_id === activeKbId)
  const displayName = activeKB?.kb_name ?? 'Select KB'

  if (!accessibleKBs.length) return null

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            className={cn(
              'flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-sm',
              'bg-surface-card border border-surface-border',
              'text-foreground hover:bg-surface-border/30',
              'transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
            )}
          >
            <Database className="w-3.5 h-3.5 text-brand-500 shrink-0" />
            <span className="max-w-[140px] truncate font-medium">{displayName}</span>
            <ChevronDown className="w-3.5 h-3.5 text-muted shrink-0" />
          </button>
        </DropdownMenu.Trigger>

        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={6}
            className={cn(
              'z-50 min-w-[200px] rounded-lg shadow-lg py-1',
              'bg-surface-card border border-surface-border',
              'animate-in fade-in-0 zoom-in-95',
            )}
          >
            <div className="px-3 py-1.5 text-xs text-muted font-medium uppercase tracking-wide">
              Knowledge Bases
            </div>

            {accessibleKBs.map((kb) => (
              <DropdownMenu.Item
                key={kb.kb_id}
                onSelect={() => setActiveKbId(kb.kb_id)}
                className={cn(
                  'flex items-center gap-2 px-3 py-2 text-sm cursor-pointer',
                  'text-foreground hover:bg-surface-border/30 outline-none',
                )}
              >
                <Check
                  className={cn(
                    'w-3.5 h-3.5 shrink-0',
                    kb.kb_id === activeKbId ? 'text-brand-500' : 'text-transparent',
                  )}
                />
                <span className="flex-1 truncate">{kb.kb_name}</span>
                {kb.active_version && (
                  <span className="text-xs text-muted font-mono">{kb.active_version}</span>
                )}
              </DropdownMenu.Item>
            ))}

            {canManageKBs && (
              <>
                <DropdownMenu.Separator className="my-1 border-t border-surface-border" />
                <DropdownMenu.Item
                  onSelect={() => setShowCreate(true)}
                  className={cn(
                    'flex items-center gap-2 px-3 py-2 text-sm cursor-pointer',
                    'text-brand-600 hover:bg-surface-border/30 outline-none',
                  )}
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Create New KB</span>
                </DropdownMenu.Item>
              </>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      {showCreate && <CreateKBModal onClose={() => setShowCreate(false)} />}
    </>
  )
}
