import { test, expect } from '@playwright/test'

for (const isPublisher of [true, false]) {
test(`business proposal carries intent into an honest approval request (publisher: ${isPublisher})`, async ({ page }, testInfo) => {
  const user = { id: 7, email: 'leader@example.test', full_name: 'Policy Owner', is_super_admin: isPublisher, permissions: {policy:{view:true,edit:true,admin:false},knowledgeBase:{view:true,edit:true,admin:true}} }
  const brief = { name: 'Faster missing-item resolution', outcome: 'Reduce manual reviews within our compensation budget', scope: 'Grocery delivery' }
  const category = { id: 1, issue_code: 'MISSING_ITEM', label: 'Missing item', level: 1, parent_code: null, status: 'accepted', proposal_type: 'existing', description: 'An ordered item did not arrive' }
  const action = { id: 1, action_code_id: 'REFUND', action_name: 'Refund missing item', status: 'accepted', proposal_type: 'existing', parent_issue_codes: ['MISSING_ITEM'], requires_refund: true, automation_eligible: false }
  const rule = { id: 1, rule_id: 'rule-1', issue_type_l1: 'MISSING_ITEM', issue_type_l2: null, action_id: 3, action_name: 'Refund missing item', priority: 500, conditions: {}, deterministic: false, min_order_value: null, max_order_value: null }
  const state = { uploaded: false, actions: false, rules: false, stage: 'DRAFT' }
  let justification = ''
  await page.addInitScript(user => { localStorage.setItem('kk_auth', JSON.stringify({ state: { user }, version: 0 })) }, user)
  await page.route('**/api/governance/**', async route => {
    const url = new URL(route.request().url())
    const path = url.pathname
    let json: unknown = []
    if (path.endsWith('/auth/me')) json = user
    else if (path.endsWith('/bpm/kbs')) json = [{ id:1, kb_id:'default', kb_name:'Customer Care', my_role:'admin', is_active:true }]
    else if (path.endsWith('/instances')) json = state.uploaded && url.searchParams.get('entity_id') === 'proposal-1' ? [{ id:1, kb_id:'default', entity_id:'proposal-1', current_stage:state.stage, started_at:'2026-09-14T10:00:00Z', created_by_name:user.email, metadata:{business_brief:brief} }] : []
    else if (path.endsWith('/upload')) {
      const body = route.request().postData() ?? ''
      expect(body).toContain(brief.name); expect(body).toContain(brief.outcome); expect(body).toContain('affected_scope')
      state.uploaded = true; json = { entity_id:'proposal-1', filename:'policy.md', bpm_instance_id:1 }
    } else if (path.endsWith('/extract-taxonomy')) json = { proposals:[category], count:1, truncated:true, analysed_characters:12000, document_characters:30000 }
    else if (path.endsWith('/taxonomy-proposals')) json = [category]
    else if (path.endsWith('/extract-actions')) { state.actions = true; json = { proposals:[action], count:1, truncated:false, analysed_characters:100, document_characters:100 } }
    else if (path.endsWith('/action-proposals')) json = state.actions ? [action] : []
    else if (path.endsWith('/generate-rules')) { state.rules = true; state.stage = 'RULE_EDIT'; json = { rules:[rule], skipped:[{issue_code:'LATE',action_code_id:'REFUND',reason:'Customer problem was not accepted in this proposal'}], count:1, stage:'RULE_EDIT' } }
    else if (path.endsWith('/action-codes')) json = [{ id:3, action_code_id:'REFUND', action_name:'Refund missing item' }]
    else if (path.endsWith('/rules/default')) json = state.rules ? [rule] : []
    else if (path.endsWith('/simulate')) { state.stage = 'SIMULATION_FAILED'; json = {status:'ok', passed:false, stage:'SIMULATION_FAILED', metrics:{unchanged_rate:0.7,changed_count:3,ticket_count:10,rule_count:1,baseline_version:'current',candidate_version:'proposal-1',threshold:0.8}, examples:[{ticket_id:1,baseline:'Manual review',candidate:'Refund missing item'}]} }
    else if (path.endsWith('/readiness')) json = { stage:state.stage, review:{taxonomy_pending:0,taxonomy_accepted:1,actions_pending:0,actions_accepted:1,rules:1}, preparation_status: state.stage === 'PENDING_APPROVAL' ? 'pending' : null, rules_unchanged_since_submission:false, pending_approval:null, live_version:'current', live_comparison_version:null, live_comparison_cases:0 }
    else if (path.endsWith('/submit')) { justification = JSON.parse(route.request().postData() ?? '{}').justification; state.stage = 'PENDING_APPROVAL'; json = { stage:'PENDING_APPROVAL', approval:{id:5} } }
    else if (path.endsWith('/publish')) throw new Error('The wizard must not activate a policy')
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
  await expect(dialog.getByText('Only the first 12,000 of 30,000 characters were analysed', {exact:false})).toBeVisible()
  await dialog.getByRole('button', {name:'Review customer problems',exact:true}).click()
  await expect(dialog.getByRole('heading', {name:'Which customer problems does this cover?'})).toBeVisible()
  await dialog.getByRole('button', {name:'Identify responses',exact:true}).click()
  await dialog.getByRole('button', {name:'Identify responses',exact:true}).click()
  await dialog.getByRole('button', {name:'Connect problems to responses',exact:true}).click()
  await expect(dialog.getByText('1 accepted pairing could not become a decision')).toBeVisible()
  await dialog.getByRole('button', {name:'Add a rule manually',exact:false}).click()
  await dialog.getByRole('spinbutton').first().fill('0')
  await expect(dialog.getByRole('spinbutton').first()).toHaveValue('0')
  await expect(dialog.getByRole('button', {name:'Add Rule',exact:true})).toBeDisabled()
  await dialog.getByLabel('Action to take *').selectOption('3')
  await dialog.getByRole('button', {name:'Cancel',exact:true}).click()
  await dialog.getByRole('button', {name:'Compare sample decisions',exact:true}).click()
  await dialog.getByRole('button', {name:'Run Preview',exact:true}).click()
  await expect(dialog.getByText('Larger change: review the differences')).toBeVisible()
  await expect(dialog.getByText('Manual review', {exact:true})).toBeVisible()
  await dialog.getByRole('button', {name:'Review evidence gaps',exact:true}).click()
  await expect(dialog.getByRole('heading', {name:brief.name,exact:true})).toBeVisible()
  await expect(dialog.getByText('3 of 10 sample cases', {exact:false})).toBeVisible()
  await expect(dialog.getByRole('button', {name:'Activate for new tickets',exact:true})).toHaveCount(0)
  const request = dialog.getByRole('button', {name:'Request approval',exact:true})
  await expect(request).toBeDisabled()
  await dialog.getByLabel('Why is this larger change intended?', {exact:false}).fill('Refunds replace manual review for missing items by design.')
  await request.click()
  await expect(dialog.getByText('Submitted for approval.', {exact:false})).toBeVisible()
  expect(justification).toContain('by design')
  await expect(dialog.getByText('Background test complete', {exact:true})).toHaveCount(0)
  await dialog.evaluate(el => el.scrollTo(0, 0))
  await page.screenshot({path:testInfo.outputPath('policy-review.png'),fullPage:true})
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
})

}

for (const ownRequest of [false, true]) {
test(`approving a policy change activates it only for a second administrator (own request: ${ownRequest})`, async ({ page }) => {
  const user = { id: 7, email: 'approver@example.test', full_name: 'Approver', is_super_admin: false, permissions: {policy:{view:true,edit:true,admin:true},knowledgeBase:{view:true,edit:true,admin:true}} }
  const instance = { id:4, kb_id:'default', entity_id:'proposal-2', entity_type:'kb_version', current_stage:'PENDING_APPROVAL', started_at:'2026-09-14T10:00:00Z', created_by_name:'author@example.test', metadata:{business_brief:{name:'Replacement first'}}, pending_approvals:1 }
  const approval = { id:11, instance_id:4, stage:'PENDING_APPROVAL', status:'pending', requested_by_id: ownRequest ? 7 : 3, requested_by: ownRequest ? user.email : 'author@example.test', requested_at:'2026-09-15T10:00:00Z' }
  let approved = 0
  await page.addInitScript(user => localStorage.setItem('kk_auth', JSON.stringify({ state: { user }, version: 0 })), user)
  await page.route('**/api/governance/**', async route => {
    const path = new URL(route.request().url()).pathname
    let json: unknown = []
    if (path.endsWith('/auth/me')) json = user
    else if (path.endsWith('/bpm/kbs')) json = [{ id:1, kb_id:'default', kb_name:'Customer Care', my_role:'admin', is_active:true }]
    else if (path.endsWith('/default/instances')) json = [instance]
    else if (path.endsWith('/approvals')) json = [approval]
    else if (path.endsWith('/readiness')) json = { stage:'PENDING_APPROVAL', review:{taxonomy_pending:0,taxonomy_accepted:1,actions_pending:0,actions_accepted:1,rules:4}, preparation_status:'completed', rules_unchanged_since_submission:true, pending_approval:approval, live_version:'proposal-1', live_comparison_version:null, live_comparison_cases:0 }
    else if (path.endsWith('/approvals/11/approve')) { approved++; json = { active_version:'proposal-2', previous_version:'proposal-1', already_live:false } }
    await route.fulfill({ json })
  })
  await page.goto('/policy/bpm')
  await page.getByRole('button', { name:/Replacement first/ }).click()
  const drawer = page.getByRole('dialog', { name:'Policy proposal details' })
  await expect(drawer.getByText('Replaces', {exact:true})).toBeVisible()
  await expect(drawer.getByText('proposal-1', {exact:true})).toBeVisible()
  const approve = drawer.getByRole('button', { name:'Approve', exact:true })
  if (ownRequest) {
    await expect(approve).toBeDisabled()
    await expect(drawer.getByText('You submitted this request', {exact:false})).toBeVisible()
    return
  }
  await approve.click()
  const activate = drawer.getByRole('button', { name:'Approve and activate', exact:true })
  await expect(activate).toBeDisabled()
  await drawer.getByLabel('I have reviewed the evidence', {exact:false}).check()
  await activate.click()
  await expect.poll(() => approved).toBe(1)
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
