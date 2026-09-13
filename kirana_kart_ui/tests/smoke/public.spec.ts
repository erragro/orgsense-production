import { test, expect } from '@playwright/test'

test('public landing page loads without runtime errors', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto('/')
  await expect(page.locator('h1')).toBeVisible()
  expect(errors).toEqual([])
})

test('anonymous dashboard access redirects to a usable login form', async ({ page }) => {
  await page.goto('/dashboard')
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByPlaceholder('you@example.com')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign In', exact: true })).toBeVisible()
  await page.getByPlaceholder('you@example.com').fill('invalid')
  await page.getByLabel('Password', { exact: true }).fill('invalid-password')
  await page.getByRole('button', { name: 'Sign In', exact: true }).click()
  await expect(page).toHaveURL(/\/login$/)
})

test('nginx applies security headers to HTML, health and missing assets', async ({ request }) => {
  test.skip(!process.env.SMOKE_BASE_URL, 'Requires the built nginx image')
  for (const path of ['/', '/index.html', '/health', '/missing.js']) {
    const response = await request.get(path)
    expect(response.headers()['x-content-type-options']).toBe('nosniff')
    expect(response.headers()['x-frame-options']).toBe('DENY')
    expect(response.headers()['content-security-policy']).toContain("script-src 'self'")
    expect(response.headers()['strict-transport-security']).toContain('max-age=')
  }
})
