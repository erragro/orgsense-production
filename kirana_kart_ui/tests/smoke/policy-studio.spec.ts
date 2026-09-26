import { test, expect } from '@playwright/test'

for (const isPublisher of [true, false]) {
test(`business proposal carries intent into an honest approval request (publisher: ${isPublisher})`, async ({ page }, testInfo) => {
  const user = { id: 7, email: 'leader@example.test', full_name: 'Policy Owner', is_super_admin: isPublisher, permissions: {policy:{view:true,edit:true,admin:false},knowledgeBase:{view:true,edit:true,admin:true}} }
  const brief = { name: 'Faster missing-item resolution', outcome: 'Reduce manual reviews within our compensation budget', scope: 'Grocery delivery' }
  const category = { id: 1, issue_code: 'MISSING_ITEM', label: 'Missing item', level: 1, parent_code: null, status: 'accepted', proposal_type: 'existing', description: 'An ordered item did not arrive' }
  const action = { id: 1, action_code_id: 'REFUND', action_name: 'Refund missing item', status: 'accepted', proposal_type: 'existing', parent_issue_codes: ['MISSING_ITEM'], requires_refund: true, automation_eligible: false }
  const rule = { id: 1, rule_id: 'rule-1', issue_type_l1: 'MISSING_ITEM', issue_type_l2: null, action_id: 3, action_name: 'Refund missing item', priority: 500, conditions: {}, deterministic: false, min_order_value: null, max_order_value: null }
  const state = { uploaded: false, actions: false, rules: false, stage: 'DRAFT', passages: false, accepted: false, hours: false }
  const gap = { id: 1, business_line: 'ecommerce', label: 'Damaged packaging', description: null, suggested_code: 'DAMAGED_PACKAGING', suggested_parent_code: null, source_excerpt: 'Crushed boxes are refunded', extraction_confidence: 0.7, status: 'open', mapped_issue_code: null, resolution_note: null }
  const passage = () => ({ id: 9, chunk_key: 'K000-ABC123', business_line: 'ecommerce', title: 'Refund window', body: 'Refund within a day. Support is open {{support_hours}}.', issue_codes: ['MISSING_ITEM'], purpose: 'decision', source_excerpt: 'Refund eligible missing items.', source_start: 16, source_end: 46, origin: 'ai', status: state.accepted ? 'accepted' : 'pending', llm_output: null, edit_reason: null, variables: ['support_hours'], undefined_variables: state.hours ? [] : ['support_hours'] })
  const posted: Record<string, unknown> = {}
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
      expect(body).toContain('name="business_line"'); expect(body).toContain('grocery')
      state.uploaded = true; json = { entity_id:'proposal-1', filename:'policy.md', bpm_instance_id:1 }
    } else if (path.endsWith('/extract-taxonomy')) json = { proposals:[category], count:1, gaps:[gap], truncated:true, analysed_characters:96000, document_characters:130000 }
    else if (path.endsWith('/business-lines')) json = { business_lines:['ecommerce','grocery'] }
    else if (path.endsWith('/lessons')) json = { business_line:'grocery', lessons:[{ id:1, stage:'chunk', item_ref:'K1', edit_type:'edited', edit_reason:'Name the business', business_line:'grocery', same_line:true, summary:'- chunk K1 corrected. Why: Name the business', created_at:'2026-09-20T10:00:00Z' }] }
    else if (path.endsWith('/live-taxonomy')) json = [{ issue_code:'MISSING_ITEM', label:'Missing item', level:1, parent_code:null, description:null }, { issue_code:'WRONG_ITEM', label:'Wrong item', level:1, parent_code:null, description:null }]
    else if (path.endsWith('/taxonomy-gaps')) json = [gap]
    else if (path.endsWith('/taxonomy-gaps/1')) { posted.gap = JSON.parse(route.request().postData() ?? '{}'); gap.status = 'mapped'; gap.mapped_issue_code = 'WRONG_ITEM'; json = { id:1, status:'mapped', mapped_issue_code:'WRONG_ITEM' } }
    else if (path.endsWith('/extract-knowledge')) { state.passages = true; json = { proposals:[passage()], count:1, suggested_variables:[{ name:'support_hours', value:'9am to 9pm', defined:false }], truncated:false, analysed_characters:100, document_characters:100 } }
    else if (path.endsWith('/knowledge')) json = { business_line:'grocery', chunks: state.passages ? [passage()] : [], undefined_variables: state.passages && !state.hours ? ['support_hours'] : [] }
    else if (path.endsWith('/accept-all')) { const body = JSON.parse(route.request().postData() ?? '{}'); posted[`accept-${body.kind}`] = body; if (body.kind === 'knowledge') state.accepted = true; json = { accepted:1 } }
    else if (path.endsWith('/variables') && route.request().method() === 'PUT') { posted.variable = JSON.parse(route.request().postData() ?? '{}'); state.hours = true; json = { id:1, business_line:'', name:'support_hours', value:'9am to 9pm', description:null, updated_at:'' } }
    else if (path.endsWith('/variables')) json = { variables:[], suggested:[{ name:'support_hours', description:'When human support is available' }], ticket_variables:[{ name:'customer_tier', description:'tier' }] }
    else if (path.endsWith('/taxonomy-proposals')) json = [category]
    else if (path.endsWith('/extract-actions')) { state.actions = true; json = { proposals:[action], count:1, truncated:false, analysed_characters:100, document_characters:100 } }
    else if (path.endsWith('/action-proposals')) json = state.actions ? [action] : []
    else if (path.endsWith('/generate-rules')) { state.rules = true; state.stage = 'RULE_EDIT'; json = { rules:[rule], skipped:[{issue_code:'LATE',action_code_id:'REFUND',reason:'Customer problem was not accepted in this proposal'}], count:1, stage:'RULE_EDIT' } }
    else if (path.endsWith('/action-codes')) json = [{ id:3, action_code_id:'REFUND', action_name:'Refund missing item' }]
    else if (path.endsWith('/rules/default')) json = state.rules ? [rule] : []
    else if (path.endsWith('/simulate')) { state.stage = 'SIMULATION_FAILED'; json = {status:'ok', passed:false, stage:'SIMULATION_FAILED', metrics:{unchanged_rate:0.7,changed_count:3,ticket_count:10,rule_count:1,baseline_version:'current',candidate_version:'proposal-1',threshold:0.8}, examples:[{ticket_id:1,baseline:'Manual review',candidate:'Refund missing item'}]} }
    else if (path.endsWith('/readiness')) json = { stage:state.stage, review:{taxonomy_pending:0,taxonomy_accepted:1,actions_pending:0,actions_accepted:1,rules:1,knowledge_pending:0,knowledge_accepted:1,gaps_open:0}, preparation_status: state.stage === 'PENDING_APPROVAL' ? 'pending' : null, rules_unchanged_since_submission:false, pending_approval:null, live_version:'current', live_comparison_version:null, live_comparison_cases:0, business_line:'grocery', undefined_variables:[] }
    else if (path.endsWith('/submit')) { justification = JSON.parse(route.request().postData() ?? '{}').justification; state.stage = 'PENDING_APPROVAL'; json = { stage:'PENDING_APPROVAL', approval:{id:5} } }
    else if (path.endsWith('/rule-decisions/summary')) json = { mode:'observe', days:7, evaluated:40, matched:30, applied:0, differs:6, last_evaluated_at:'2026-09-25T10:00:00Z', by_rule:[{ rule_id:'R-MISSING-REFUND', rule_action:'REFUND', matched:30, differs:6 }] }
    else if (path.endsWith('/publish')) throw new Error('The wizard must not activate a policy')
    await route.fulfill({ json })
  })
  await page.goto('/policy/bpm')
  await expect(page.getByRole('heading', { name:'Policy Studio', exact:true })).toBeVisible()
  const rulesPanel = page.getByRole('region', { name:'Rules in live decisions' })
  await expect(rulesPanel.getByText('Observe only: rules do not change decisions')).toBeVisible()
  await expect(rulesPanel.getByText('on 6 (15%) it would have decided differently from the AI', { exact:false })).toBeVisible()
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
  await dialog.getByLabel('Business line', {exact:false}).fill('grocery')
  await dialog.locator('input[type=file]').setInputFiles({name:'policy.md',mimeType:'text/markdown',buffer:Buffer.from('# Missing items\nRefund eligible missing items.')})
  await dialog.getByRole('button', {name:'Create proposal',exact:true}).click()
  await dialog.getByRole('button', {name:'Identify customer problems',exact:true}).click()
  await expect(dialog.getByText('Only the first 96,000 of 130,000 characters were analysed', {exact:false})).toBeVisible()
  await expect(dialog.getByText('1 problem your taxonomy has no code for', {exact:false})).toBeVisible()
  await dialog.getByText('What the AI has learned from reviewers (1)', {exact:false}).click()
  await expect(dialog.getByText('Why: Name the business', {exact:false})).toBeVisible()
  await dialog.getByRole('button', {name:'Review customer problems',exact:true}).click()
  await expect(dialog.getByRole('heading', {name:'Which customer problems does this cover?'})).toBeVisible()
  // A correction needs a reason before it can be saved.
  await dialog.getByRole('button', {name:'Reject',exact:true}).first().click()
  await expect(dialog.getByRole('button', {name:'Reject',exact:true}).last()).toBeDisabled()
  await dialog.getByRole('button', {name:'Cancel',exact:true}).click()
  // A problem the taxonomy lacks is mapped onto a live code, never created.
  const gaps = dialog.getByRole('region', {name:'Problems your taxonomy does not cover'})
  await gaps.getByLabel('Existing problem that covers it').selectOption('WRONG_ITEM')
  await gaps.getByLabel('Why?', {exact:false}).fill('Crushed boxes count as wrong items here')
  await gaps.getByRole('button', {name:'Map',exact:true}).click()
  await page.screenshot({path:testInfo.outputPath('policy-mapping.png'),fullPage:true})
  await expect.poll(() => posted.gap).toEqual({ action:'map', issue_code:'WRONG_ITEM', note:'Crushed boxes count as wrong items here' })
  await dialog.getByRole('button', {name:'Identify responses',exact:true}).click()
  await dialog.getByRole('button', {name:'Identify responses',exact:true}).click()
  await dialog.getByRole('button', {name:'Connect problems to responses',exact:true}).click()
  await expect(dialog.getByText('1 accepted pairing could not become a decision')).toBeVisible()
  await dialog.getByRole('button', {name:'Add a rule manually',exact:false}).click()
  await dialog.getByRole('spinbutton').first().fill('0')
  await expect(dialog.getByRole('spinbutton').first()).toHaveValue('0')
  await expect(dialog.getByRole('button', {name:'Add Rule',exact:true})).toBeDisabled()
  await dialog.getByLabel('Action to take *').selectOption('3')
  await dialog.getByLabel('Refund amount source').selectOption('percent')
  await dialog.getByLabel('Percent of order').fill('50')
  await dialog.getByLabel('Never more than (₹)').fill('400')
  await dialog.getByRole('button', {name:'Cancel',exact:true}).click()
  await dialog.getByRole('button', {name:'Review SOP knowledge',exact:true}).click()
  await dialog.getByRole('button', {name:'Extract passages',exact:true}).click()
  await expect(dialog.getByText('Support is open {{support_hours}}.', {exact:false})).toBeVisible()
  await expect(dialog.getByText('(found in the SOP)', {exact:false})).toBeVisible()
  const next = dialog.getByRole('button', {name:'Compare sample decisions',exact:true})
  await expect(next).toBeDisabled()
  await dialog.getByRole('button', {name:'Accept all (1)',exact:true}).click()
  await expect.poll(() => posted['accept-knowledge']).toEqual({ kind:'knowledge' })
  await expect(dialog.getByLabel('Value for support_hours')).toHaveValue('9am to 9pm')    // found in the SOP
  await page.screenshot({path:testInfo.outputPath('policy-knowledge.png'),fullPage:true})
  await dialog.getByRole('region', {name:'Variables'}).getByRole('button', {name:'Save',exact:true}).click()
  await expect.poll(() => posted.variable).toEqual({ name:'support_hours', value:'9am to 9pm', business_line:null })
  await next.click()
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
