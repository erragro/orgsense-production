// src/api/governance/integrations.api.ts
// =========================================
// API client for the Channel Integrations module.

import { governanceClient } from '@/api/clients'
import type {
  Integration,
  CreateIntegrationPayload,
  UpdateIntegrationPayload,
  TestResult,
  GenerateKeyResult,
} from '@/types/integration.types'

export const integrationsApi = {
  /** List all integrations (config fields redacted). */
  list: () => governanceClient.get<Integration[]>('/integrations'),

  /** Get a single integration by ID (config redacted). */
  get: (id: number) => governanceClient.get<Integration>(`/integrations/${id}`),

  /** Get the full unredacted config for an integration (system.admin only). */
  getConfig: (id: number) =>
    governanceClient.get<Integration>(`/integrations/${id}/config`),

  /** Create a new integration. For API type, api_key is returned in the response once. */
  create: (data: CreateIntegrationPayload) =>
    governanceClient.post<Integration>('/integrations', data),

  /** Patch an existing integration (name / org / module / config). */
  update: (id: number, data: UpdateIntegrationPayload) =>
    governanceClient.patch<Integration>(`/integrations/${id}`, data),

  /** Delete an integration and revoke its API key from admin_users. */
  delete: (id: number) => governanceClient.delete(`/integrations/${id}`),

  /** Toggle is_active on or off. */
  toggle: (id: number) => governanceClient.post<Integration>(`/integrations/${id}/toggle`),

  /** Test connectivity for an integration. */
  test: (id: number) =>
    governanceClient.post<TestResult>(`/integrations/${id}/test`),

  /** Trigger a manual poll cycle (email integrations only). */
  sync: (id: number) =>
    governanceClient.post<{ status: string; integration_id: number }>(
      `/integrations/${id}/sync`,
    ),

  /** Generate a fresh kk_live_ API key (returned once, caller must store it). */
  generateKey: () => governanceClient.post<GenerateKeyResult>('/integrations/generate-key'),
}
