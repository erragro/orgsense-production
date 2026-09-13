/**
 * kb.store.ts
 *
 * Global KB context — tracks which Knowledge Base the user is currently
 * working in. All KB/taxonomy/BPM/QA API calls use this active kb_id.
 *
 * Persisted to localStorage so the selection survives page refresh.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { KnowledgeBase } from '../api/governance/bpm.api'

interface KBStore {
  activeKbId: string
  accessibleKBs: KnowledgeBase[]
  setActiveKbId: (kbId: string) => void
  setAccessibleKBs: (kbs: KnowledgeBase[]) => void
  getActiveKB: () => KnowledgeBase | undefined
}

export const useKBStore = create<KBStore>()(
  persist(
    (set, get) => ({
      activeKbId: 'default',
      accessibleKBs: [],

      setActiveKbId: (kbId) => set({ activeKbId: kbId }),

      setAccessibleKBs: (kbs) => {
        const current = get().activeKbId
        // If the current selection is no longer accessible, switch to the first
        const stillValid = kbs.some((kb) => kb.kb_id === current)
        set({
          accessibleKBs: kbs,
          activeKbId: stillValid ? current : (kbs[0]?.kb_id ?? 'default'),
        })
      },

      getActiveKB: () => {
        const { accessibleKBs, activeKbId } = get()
        return accessibleKBs.find((kb) => kb.kb_id === activeKbId)
      },
    }),
    {
      name: 'kk_kb_context',
      partialize: (state) => ({ activeKbId: state.activeKbId }),
    },
  ),
)
