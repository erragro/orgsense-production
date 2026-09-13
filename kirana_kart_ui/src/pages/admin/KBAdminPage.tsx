/**
 * KBAdminPage — Super admin page to manage all Knowledge Bases.
 * Lists all KBs as cards, lets admin create new ones and manage team members.
 */

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Database, Plus, Users, BookOpen, Settings, ChevronRight,
  UserPlus, Trash2, Shield, Eye, Pencil,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { bpmApi, type KnowledgeBase, type KBMember, type KBRole } from '@/api/governance/bpm.api'
import { CreateKBModal } from './components/CreateKBModal'
import { useAuthStore } from '@/stores/auth.store'

const ROLE_ICONS: Record<KBRole, typeof Eye> = {
  view: Eye,
  edit: Pencil,
  admin: Shield,
}

const ROLE_LABELS: Record<KBRole, string> = {
  view: 'View only',
  edit: 'Can edit',
  admin: 'Admin',
}

const ROLE_COLORS: Record<KBRole, string> = {
  view: 'text-blue-600 bg-blue-50 dark:bg-blue-900/20',
  edit: 'text-amber-600 bg-amber-50 dark:bg-amber-900/20',
  admin: 'text-brand-600 bg-brand-50 dark:bg-brand-900/20',
}

export function KBAdminPage() {
  const { user } = useAuthStore()
  const qc = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)
  const [selectedKB, setSelectedKB] = useState<KnowledgeBase | null>(null)
  const [addUserId, setAddUserId] = useState('')
  const [addRole, setAddRole] = useState<KBRole>('edit')
  const [addError, setAddError] = useState<string | null>(null)

  const { data: kbs = [], isLoading } = useQuery({
    queryKey: ['bpm', 'kbs'],
    queryFn: () => bpmApi.listKBs().then((r) => r.data),
  })

  const { data: members = [] } = useQuery({
    queryKey: ['bpm', 'kbs', selectedKB?.kb_id, 'members'],
    queryFn: () => bpmApi.getKBMembers(selectedKB!.kb_id).then((r) => r.data),
    enabled: !!selectedKB,
  })

  const addMember = useMutation({
    mutationFn: () =>
      bpmApi.setKBMember(selectedKB!.kb_id, parseInt(addUserId), addRole),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bpm', 'kbs', selectedKB?.kb_id, 'members'] })
      setAddUserId('')
      setAddError(null)
    },
    onError: () => setAddError('Failed to add member. Check the user ID.'),
  })

  const removeMember = useMutation({
    mutationFn: (userId: number) =>
      bpmApi.removeKBMember(selectedKB!.kb_id, userId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bpm', 'kbs', selectedKB?.kb_id, 'members'] })
    },
  })

  return (
    <div className="max-w-6xl mx-auto py-8 px-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Knowledge Bases</h1>
          <p className="text-sm text-muted mt-0.5">Manage all knowledge bases and team access</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 transition-colors"
        >
          <Plus className="w-4 h-4" />
          Create New KB
        </button>
      </div>

      {isLoading && (
        <div className="flex justify-center py-16">
          <div className="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {/* KB Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
        {kbs.map((kb) => (
          <div
            key={kb.kb_id}
            className={cn(
              'bg-surface-card border border-surface-border rounded-xl p-5 cursor-pointer',
              'hover:border-brand-500/50 transition-all',
              selectedKB?.kb_id === kb.kb_id && 'border-brand-500 ring-1 ring-brand-500/30',
            )}
            onClick={() => setSelectedKB(selectedKB?.kb_id === kb.kb_id ? null : kb)}
          >
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 bg-brand-50 dark:bg-brand-900/20 rounded-lg flex items-center justify-center">
                  <Database className="w-4 h-4 text-brand-600" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-foreground">{kb.kb_name}</p>
                  <p className="text-xs text-muted font-mono">{kb.kb_id}</p>
                </div>
              </div>
              <ChevronRight
                className={cn(
                  'w-4 h-4 text-muted transition-transform',
                  selectedKB?.kb_id === kb.kb_id && 'rotate-90',
                )}
              />
            </div>

            {kb.description && (
              <p className="text-xs text-muted mb-3 line-clamp-2">{kb.description}</p>
            )}

            <div className="flex items-center gap-4 text-xs text-muted">
              <span className="flex items-center gap-1">
                <BookOpen className="w-3.5 h-3.5" />
                {kb.active_version ?? 'No active version'}
              </span>
              {kb.member_count !== undefined && (
                <span className="flex items-center gap-1">
                  <Users className="w-3.5 h-3.5" />
                  {kb.member_count} members
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Member Management Panel */}
      {selectedKB && (
        <div className="bg-surface-card border border-surface-border rounded-xl p-6">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-base font-semibold text-foreground">
                {selectedKB.kb_name} — Team Members
              </h2>
              <p className="text-xs text-muted mt-0.5">
                Manage who can view, edit, or administer this KB
              </p>
            </div>
            <Settings className="w-4 h-4 text-muted" />
          </div>

          {/* Add member form */}
          <div className="flex items-end gap-3 mb-6 p-4 bg-surface rounded-lg border border-surface-border">
            <div className="flex-1">
              <label className="block text-xs font-medium text-muted mb-1">User ID</label>
              <input
                type="number"
                value={addUserId}
                onChange={(e) => setAddUserId(e.target.value)}
                placeholder="Enter user ID"
                className={cn(
                  'w-full px-3 py-2 rounded-lg border text-sm',
                  'bg-surface-card border-surface-border text-foreground',
                  'placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-brand-500',
                )}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted mb-1">Role</label>
              <select
                value={addRole}
                onChange={(e) => setAddRole(e.target.value as KBRole)}
                className={cn(
                  'px-3 py-2 rounded-lg border text-sm',
                  'bg-surface-card border-surface-border text-foreground',
                  'focus:outline-none focus:ring-2 focus:ring-brand-500',
                )}
              >
                <option value="view">View only</option>
                <option value="edit">Can edit</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <button
              onClick={() => {
                setAddError(null)
                if (!addUserId) { setAddError('User ID required'); return }
                addMember.mutate()
              }}
              disabled={addMember.isPending}
              className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-50 transition-colors"
            >
              <UserPlus className="w-4 h-4" />
              Add
            </button>
          </div>

          {addError && (
            <p className="text-sm text-red-500 mb-4">{addError}</p>
          )}

          {/* Member list */}
          <div className="space-y-2">
            {members.length === 0 && (
              <p className="text-sm text-muted text-center py-8">
                No team members yet. Add members above to grant KB access.
              </p>
            )}
            {members.map((member: KBMember) => {
              const RoleIcon = ROLE_ICONS[member.role]
              const isMe = member.user_id === user?.id
              return (
                <div
                  key={member.id}
                  className="flex items-center justify-between p-3 rounded-lg border border-surface-border"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 bg-surface rounded-full flex items-center justify-center text-xs font-semibold text-foreground uppercase">
                      {(member.full_name ?? member.email).slice(0, 2)}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-foreground">
                        {member.full_name ?? member.email}
                        {isMe && <span className="ml-1.5 text-xs text-brand-500">(you)</span>}
                      </p>
                      <p className="text-xs text-muted">{member.email}</p>
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <span className={cn('flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium', ROLE_COLORS[member.role])}>
                      <RoleIcon className="w-3 h-3" />
                      {ROLE_LABELS[member.role]}
                    </span>
                    {!isMe && (
                      <button
                        onClick={() => removeMember.mutate(member.user_id)}
                        disabled={removeMember.isPending}
                        className="text-muted hover:text-red-500 transition-colors disabled:opacity-50"
                        title="Remove member"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {showCreate && <CreateKBModal onClose={() => setShowCreate(false)} />}
    </div>
  )
}

export default KBAdminPage
