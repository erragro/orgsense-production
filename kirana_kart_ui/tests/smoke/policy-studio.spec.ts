import { test, expect } from '@playwright/test'

for (const isPublisher of [true, false]) {
test(`business proposal carries intent into an honest launch review (publisher: ${isPublisher})`, async ({ page }, testInfo) => {
  const user = { id: 7, email: 'leader@example.test', full_name: 'Policy Owner', is_super_admin: isPublisher, permissions: {policy:{view:true,edit:true,admin:false},knowledgeBase:{view:true,edit:true,admin:true}} }
  const brief = { name: 'Faster missing-item resolution', outcome: 'Reduce manual reviews within our compensation budget', scope: 'Grocery delivery' }
  const category = { id: 1, issue_code: 'MISSING_ITEM', label: 'Missing item', level: 0, parent_code: null, status: 'accepted', proposal_type: 'existing', description: 'An ordered item did not arrive' }
  const action = { id: 1, action_code_id: 'REFUND', action_name: 'Refund missing item', status: 'accepted', proposal_type: 'existing', parent_issue_codes: ['MISSING_ITEM'], requires_refund: true, automation_eligible: false }
  const rule = { id: 1, rule_id: 'rule-1', issue_type_l1: 'MISSING_ITEM', issue_type_l2: null, action_name: 'Refund missing item', priority: 50, conditions: {}, deterministic: false, min_order_value: null, max_order_value: null }
  let uploaded = false
  await page.addInitScript(user => { localStorage.setItem('kk_auth', JSON.stringify({ state: { user }, version: 0 })) }, user)
  await page.route('**/api/governance/**', async route => {
    const path = new URL(route.request().url()).pathname
    let json: unknown = []
    if (path.endsWith('/auth/me')) json = user
    else if (path.endsWith('/bpm/kbs')) json = [{ id:1, kb_id:'default', kb_name:'Customer Care', my_role:'admin', is_active:true }]
    else if (path.endsWith('/instances')) json = uploaded && new URL(route.request().url()).searchParams.get('entity_id') === 'proposal-1' ? [{ id:1, kb_id:'default', entity_id:'proposal-1', current_stage:'RULE_EDIT', started_at:'2026-09-14T10:00:00Z', created_by_name:user.email, metadata:{business_brief:brief} }] : []
    else if (path.endsWith('/upload')) {
      const body = route.request().postData() ?? ''
      expect(body).toContain(brief.name); expect(body).toContain(brief.outcome); expect(body).toContain('affected_scope')
      uploaded = true; json = { entity_id:'proposal-1', filename:'policy.md', bpm_instance_id:1 }
    } else if (path.endsWith('/extract-taxonomy')) json = { proposals:[category] }
    else if (path.endsWith('/taxonomy-proposals')) json = [category]
    else if (path.endsWith('/extract-actions') || path.endsWith('/action-proposals')) json = [action]
    else if (path.endsWith('/generate-rules') || path.endsWith('/rules/default')) json = [rule]
    else if (path.endsWith('/simulate')) json = {status:'ok', passed:false, metrics:{unchanged_rate:0.7,changed_count:3,ticket_count:10,rule_count:1,baseline_version:'current',candidate_version:'proposal-1',threshold:0.8,examples:[{ticket_id:1,baseline:'Manual review',candidate:'Refund missing item'}]}}
    await route.fulfill({ json })
  })
  await page.goto('/policy/bpm')
  await expect(page.getByRole('heading', { name:'Policy Studio', exact:true })).toBeVisible()
  await page.getByText('How customer problems, decisions and tests connect').click()
  await expect(page.getByText('Illustrative example:', { exact:false })).toBeVisible()
  await page.screenshot({ path:testInfo.outputPath('policy-studio.png'), fullPage:true })
  await page.getByRole('button', { name:'Create policy change', exact:true }).click()
  const dialog = page.getByRole('dialog', { name:'Create a policy change' })
  await page.setViewportSize({ width:390, height:844 })
  await expect(dialog).toBeVisible()
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
  await page.setViewportSize({ width:1280, height:900 })
  await expect(dialog.getByRole('button', {name:'Create proposal',exact:true})).toBeDisabled()
  await dialog.getByLabel('Name this change').fill(brief.name)
  await dialog.getByLabel('What business outcome are you aiming for?').fill(brief.outcome)
  await dialog.getByLabel('Who or what should this affect?', {exact:false}).fill(brief.scope)
  await dialog.locator('input[type=file]').setInputFiles({name:'policy.md',mimeType:'text/markdown',buffer:Buffer.from('# Missing items\nRefund eligible missing items.')})
  await dialog.getByRole('button', {name:'Create proposal',exact:true}).click()
  await dialog.getByRole('button', {name:'Identify customer problems',exact:true}).click()
  await expect(dialog.getByRole('heading', {name:'Which customer problems does this cover?'})).toBeVisible()
  await dialog.getByRole('button', {name:'Identify responses',exact:true}).click()
  await dialog.getByRole('button', {name:'Identify responses',exact:true}).click()
  await dialog.getByRole('button', {name:'Connect problems to responses',exact:true}).click()
  await dialog.getByRole('button', {name:'Add a rule manually',exact:false}).click()
  await dialog.getByRole('spinbutton').first().fill('0')
  await expect(dialog.getByRole('spinbutton').first()).toHaveValue('0')
  await dialog.getByRole('button', {name:'Cancel',exact:true}).click()
  await dialog.getByRole('button', {name:'Compare sample decisions',exact:true}).click()
  await dialog.getByRole('button', {name:'Run Preview',exact:true}).click()
  await expect(dialog.getByText('Larger change: review the differences')).toBeVisible()
  await expect(dialog.getByText('Manual review', {exact:true})).toBeVisible()
  await dialog.getByRole('button', {name:'Review evidence gaps',exact:true}).click()
  await expect(dialog.getByRole('heading', {name:brief.name,exact:true})).toBeVisible()
  await expect(dialog.getByText('3 of 10 sample cases', {exact:false})).toBeVisible()
  if (isPublisher) await expect(dialog.getByRole('button', {name:'Activate for new tickets',exact:true})).toBeDisabled()
  else await expect(dialog.getByRole('button', {name:'Activate for new tickets',exact:true})).toHaveCount(0)
  await expect(dialog.getByText('Background test complete', {exact:true})).toHaveCount(0)
  await dialog.evaluate(el => el.scrollTo(0, 0))
  await page.screenshot({path:testInfo.outputPath('policy-review.png'),fullPage:true})
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
})

}

test('a configured live comparison with no cases is not presented as passed', async ({ page }) => {
  const user = {id:7,email:'leader@example.test',full_name:'Leader',is_super_admin:true,permissions:{}}
  await page.addInitScript(user => localStorage.setItem('kk_auth',JSON.stringify({state:{user},version:0})), user)
  await page.route('**/api/governance/**', async route => {
    const path = new URL(route.request().url()).pathname
    const json = path.endsWith('/auth/me') ? user : path.endsWith('/shadow/stats') ? {kb_id:'default',active_version:'current',shadow_version:'proposal',is_active:true,total_evaluated:0,decisions_changed:0,change_rate:0,last_evaluated_at:null} : path.endsWith('/kb/active-version') ? {active_version:'current'} : []
    await route.fulfill({json})
  })
  await page.goto('/policy?view=shadow')
  await expect(page.getByText('Configured',{exact:true})).toBeVisible()
  await expect(page.getByRole('status')).toContainText('No comparison evidence received')
})

test('legacy conditions remain visible and cannot be overwritten by the guided editor', async ({ page }) => {
  const user = {id:7,email:'leader@example.test',is_super_admin:true,permissions:{}}
  let writes = 0
  await page.addInitScript(user => localStorage.setItem('kk_auth',JSON.stringify({state:{user},version:0})), user)
  await page.route('**/api/governance/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (route.request().method() === 'PUT') writes++
    const json = path.endsWith('/auth/me') ? user : path.endsWith('/rules/default') ? [{id:1,rule_id:'legacy-1',issue_type_l1:'MISSING_ITEM',action_id:1,action_name:'Refund',priority:0,conditions:{legacy_minimum:250}}] : path.endsWith('/validate') ? {warnings:[],conflicts:[],duplicates:[],model_status:'ready'} : path.endsWith('/action-codes') ? [{id:1,action_name:'Refund'}] : []
    await route.fulfill({json})
  })
  await page.goto('/policy/rules?kb=default&version=legacy')
  await page.getByTitle('Edit rule', {exact:true}).click()
  await expect(page.getByRole('alert')).toContainText('Saving is disabled')
  await page.getByText('View original conditions', {exact:true}).click()
  await expect(page.locator('pre')).toContainText('legacy_minimum')
  await expect(page.getByRole('button', {name:'Save Changes',exact:false})).toBeDisabled()
  expect(writes).toBe(0)
})
