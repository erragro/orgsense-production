import { test, expect } from '@playwright/test'

// Contract test for the current cookie flow. Backend cookie issuance and token
// revocation are covered separately; this exercises browser login and reload.
test('login uses cookies and never persists bearer credentials', async ({ page }) => {
  const user = { id: 7, email: 'viewer@example.test', full_name: 'Viewer', is_super_admin: false,
    permissions: { dashboard: { view: true, edit: false, admin: false } } }
  let loggedIn = false
  await page.route('**/api/governance/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/auth/login')) {
      expect(route.request().postDataJSON()).toEqual({ email: user.email, password: 'example-password' })
      expect(route.request().headers()['x-admin-token']).toBeUndefined()
      loggedIn = true
      await route.fulfill({ json: { user, access_token: 'test-access', refresh_token: 'test-refresh' },
        headers: { 'set-cookie': 'access_token=test-access; HttpOnly; Path=/; SameSite=Lax' } })
    } else if (path.endsWith('/auth/me')) {
      await route.fulfill({ status: loggedIn ? 200 : 401, json: loggedIn ? user : { detail: 'Unauthorized' } })
    } else {
      await route.fulfill({ status: 200, json: {} })
    }
  })
  await page.goto('/login')
  await page.getByPlaceholder('you@example.com').fill(user.email)
  await page.getByLabel('Password', { exact: true }).fill('example-password')
  await page.getByRole('button', { name: 'Sign In', exact: true }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
  const stored = await page.evaluate(() => JSON.stringify(localStorage))
  expect(stored).not.toContain('test-access')
  expect(stored).not.toContain('test-refresh')
  expect(await page.evaluate(() => document.cookie)).not.toContain('test-access')
  await page.reload()
  await expect(page).toHaveURL(/\/dashboard$/)
})
