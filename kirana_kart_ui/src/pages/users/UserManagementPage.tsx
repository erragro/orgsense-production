import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { usersApi, type UserWithPermissions, type UserPermissionsUpdate } from '@/api/governance/users.api'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Switch } from '@/components/ui/Switch'
import { Spinner } from '@/components/ui/Spinner'
import { useAuthStore } from '@/stores/auth.store'

const ALL_MODULES = [
  'dashboard', 'tickets', 'taxonomy', 'knowledgeBase', 'policy',
  'customers', 'analytics', 'system', 'biAgent', 'sandbox',
] as const

type ModuleName = (typeof ALL_MODULES)[number]

interface PermState {
  view: boolean
  edit: boolean
  admin: boolean
}

export default function UserManagementPage() {
  const queryClient = useQueryClient()
  const currentUser = useAuthStore((s) => s.user)
  const [selectedUser, setSelectedUser] = useState<UserWithPermissions | null>(null)
  const [permState, setPermState] = useState<Record<ModuleName, PermState>>({} as Record<ModuleName, PermState>)
  const [saveError, setSaveError] = useState('')

  const { data: users, isLoading } = useQuery({
    queryKey: ['users'],
    queryFn: () => usersApi.list().then((r) => r.data),
  })

  const updatePermsMutation = useMutation({
    mutationFn: ({ id, updates }: { id: number; updates: UserPermissionsUpdate[] }) =>
      usersApi.updatePermissions(id, updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] })
      setSaveError('')
    },
    onError: (err: unknown) => {
      const e = err as { response?: { data?: { detail?: string } } }
      setSaveError(e.response?.data?.detail ?? 'Failed to save permissions')
    },
  })

  const deactivateMutation = useMutation({
    mutationFn: (id: number) => usersApi.deactivate(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
  })

  const activateMutation = useMutation({
    mutationFn: (id: number) => usersApi.activate(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
  })

  const openUser = (user: UserWithPermissions) => {
    setSelectedUser(user)
    setSaveError('')
    const state = {} as Record<ModuleName, PermState>
    for (const mod of ALL_MODULES) {
      const p = user.permissions?.[mod]
      state[mod] = {
        view: p?.view ?? false,
        edit: p?.edit ?? false,
        admin: p?.admin ?? false,
      }
    }
    setPermState(state)
  }

  const handleSavePerms = () => {
    if (!selectedUser) return
    const updates: UserPermissionsUpdate[] = ALL_MODULES.map((mod) => ({
      module: mod,
      can_view: permState[mod].view,
      can_edit: permState[mod].edit,
      can_admin: permState[mod].admin,
    }))
    updatePermsMutation.mutate({ id: selectedUser.id, updates })
  }

  const togglePerm = (mod: ModuleName, perm: 'view' | 'edit' | 'admin') => {
    setPermState((prev) => ({
      ...prev,
      [mod]: { ...prev[mod], [perm]: !prev[mod][perm] },
    }))
  }

  return (
    <div className="max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-foreground">User Management</h1>
        <p className="text-sm text-muted mt-1">Manage users and their module permissions.</p>
      </div>

      <div className="flex gap-6">
        {/* User list */}
        <div className="flex-1 min-w-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Spinner size="lg" />
            </div>
          ) : (
            <div className="bg-surface-card border border-surface-border rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-surface-border bg-surface">
                    <th className="text-left px-4 py-3 text-xs font-semibold text-subtle uppercase tracking-wider">User</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-subtle uppercase tracking-wider">Status</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-subtle uppercase tracking-wider">Role</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-subtle uppercase tracking-wider">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {(users ?? []).map((user) => (
                    <tr
                      key={user.id}
                      className={`border-b border-surface-border last:border-0 hover:bg-surface cursor-pointer transition-colors ${selectedUser?.id === user.id ? 'bg-brand-600/5' : ''}`}
                      onClick={() => openUser(user)}
                    >
                      <td className="px-4 py-3">
                        <p className="font-medium text-foreground">{user.full_name || '—'}</p>
                        <p className="text-xs text-subtle">{user.email}</p>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={user.is_active ? 'green' : 'red'}>
                          {user.is_active ? 'Active' : 'Inactive'}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        {user.is_super_admin ? (
                          <Badge variant="amber">Super Admin</Badge>
                        ) : (
                          <span className="text-muted text-xs">Standard</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {currentUser?.id !== user.id && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              if (user.is_active) deactivateMutation.mutate(user.id)
                              else activateMutation.mutate(user.id)
                            }}
                            className="text-xs text-muted hover:text-foreground transition-colors"
                          >
                            {user.is_active ? 'Deactivate' : 'Activate'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Permission editor */}
        {selectedUser && (
          <div className="w-80 shrink-0">
            <div className="bg-surface-card border border-surface-border rounded-xl p-5 sticky top-6">
              <div className="mb-4">
                <p className="font-semibold text-foreground">{selectedUser.full_name || selectedUser.email}</p>
                <p className="text-xs text-subtle mt-0.5">{selectedUser.email}</p>
              </div>

              {selectedUser.is_super_admin ? (
                <p className="text-sm text-muted py-4 text-center">
                  Super admins have full access to all modules.
                </p>
              ) : (
                <>
                  <div className="space-y-1 max-h-[60vh] overflow-y-auto pr-1">
                    {ALL_MODULES.map((mod) => (
                      <div key={mod} className="rounded-lg bg-surface p-3">
                        <p className="text-xs font-semibold text-foreground mb-2 capitalize">
                          {mod.replace(/([A-Z])/g, ' $1').trim()}
                        </p>
                        <div className="flex items-center gap-4">
                          {(['view', 'edit', 'admin'] as const).map((perm) => (
                            <label key={perm} className="flex items-center gap-1.5 cursor-pointer">
                              <Switch
                                checked={permState[mod]?.[perm] ?? false}
                                onCheckedChange={() => togglePerm(mod, perm)}
                              />
                              <span className="text-xs text-muted capitalize">{perm}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>

                  {saveError && (
                    <p className="text-xs text-red-400 mt-3">{saveError}</p>
                  )}

                  <Button
                    className="w-full mt-4"
                    loading={updatePermsMutation.isPending}
                    onClick={handleSavePerms}
                  >
                    Save Permissions
                  </Button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
