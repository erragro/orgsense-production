import { governanceClient } from '../clients'
import type { User } from '@/stores/auth.store'

export interface UserPermissionsUpdate {
  module: string
  can_view: boolean
  can_edit: boolean
  can_admin: boolean
}

export interface UserWithPermissions extends User {
  is_active: boolean
  created_at: string
}

export const usersApi = {
  list: () =>
    governanceClient.get<UserWithPermissions[]>('/users'),

  get: (id: number) =>
    governanceClient.get<UserWithPermissions>(`/users/${id}`),

  updatePermissions: (id: number, updates: UserPermissionsUpdate[]) =>
    governanceClient.patch(`/users/${id}/permissions`, { permissions: updates }),

  deactivate: (id: number) =>
    governanceClient.patch(`/users/${id}/deactivate`),

  activate: (id: number) =>
    governanceClient.patch(`/users/${id}/activate`),

  delete: (id: number) =>
    governanceClient.delete(`/users/${id}`),
}
