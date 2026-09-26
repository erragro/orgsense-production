// Plain-English labels for Policy Studio lifecycle stages. The stages advance
// on the server as work completes (see policy_lifecycle.py); none of them is a
// background job the user waits on.
export const STAGE_LABEL: Record<string, string> = {
  DRAFT:                  'Starting up',
  AI_COMPILE_QUEUED:      'Reviewing the AI interpretation',
  AI_COMPILE_FAILED:      'Analysis failed',
  RULE_EDIT:              'Reviewing decisions',
  SIMULATION_GATE:        'Comparing sample decisions',
  SIMULATION_FAILED:      'Larger change: justify or revise',
  SHADOW_GATE:            'Tested: ready to request approval',
  SHADOW_DIVERGENCE_HIGH: 'Live comparison differences need review',
  PENDING_APPROVAL:       'Waiting for approval',
  REJECTED:               'Rejected: needs revision',
  ACTIVE:                 'Live',
  ROLLBACK_PENDING:       'Restore request pending',
  RETIRED:                'Retired',
}

// Stages in which the proposal can still be changed in the wizard.
export const EDITABLE_STAGES = new Set([
  'DRAFT', 'AI_COMPILE_QUEUED', 'AI_COMPILE_FAILED', 'RULE_EDIT',
  'SIMULATION_GATE', 'SIMULATION_FAILED', 'SHADOW_GATE', 'SHADOW_DIVERGENCE_HIGH', 'REJECTED',
])

export const CLOSED_STAGES = ['RETIRED', 'REJECTED', 'AI_COMPILE_FAILED', 'SHADOW_DIVERGENCE_HIGH']
