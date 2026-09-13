import axios from 'axios'

// withCredentials: true ensures HttpOnly auth cookies are sent on every request.
// This is required for the token-in-cookie security model (replaces localStorage tokens).

export const ingestClient = axios.create({
  baseURL: import.meta.env.VITE_INGEST_API_URL ?? (import.meta.env.PROD ? '/api/ingest' : 'http://localhost:8000'),
  timeout: 30_000,
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true,
})

export const governanceClient = axios.create({
  baseURL: import.meta.env.VITE_GOVERNANCE_API_URL ?? (import.meta.env.PROD ? '/api/governance' : 'http://localhost:8001'),
  timeout: 30_000,
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true,
})
