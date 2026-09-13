import type { User } from '@/stores/auth.store'

export type AppModule =
  | 'dashboard'
  | 'tickets'
  | 'taxonomy'
  | 'knowledgeBase'
  | 'policy'
  | 'customers'
  | 'analytics'
  | 'system'
  | 'biAgent'
  | 'sandbox'
  | 'cardinal'
  | 'qaAgent'
  | 'crm'

export type Permission = 'view' | 'edit' | 'admin'

export function hasPermission(
  user: User | null | undefined,
  module: AppModule,
  perm: Permission
): boolean {
  if (!user) return false
  if (user.is_super_admin) return true
  const mod = user.permissions?.[module]
  if (!mod) return false
  if (perm === 'view') return mod.view
  if (perm === 'edit') return mod.edit
  if (perm === 'admin') return mod.admin
  return false
}

export function canView(user: User | null | undefined, module: AppModule): boolean {
  return hasPermission(user, module, 'view')
}
