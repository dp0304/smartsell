import { randomUUID, createHash } from 'node:crypto';

export async function exercise({ runtime, tools, rest, call, rows, assert, ws, seed, pair, legacyOnly }) {
  const command = runtime === 'commands';
  const start = new Date(Date.now() + 86400000).toISOString();
  const end = new Date(Date.now() + 7 * 86400000).toISOString();
  const checkField = (field, value) => row => assert.deepEqual(row?.[field], value, `Expected ${field} to equal ${JSON.stringify(value)}`);
  const hasId = id => data => assert(rows(data).some(row => row.id === id), `Expected fixture record ${id}`);
  const contains = marker => data => assert(JSON.stringify(data)?.includes(String(marker)), `Expected fixture value ${marker}`);
  const input = (body, params, version, query) => ({ ...(body && { body }), ...(params && { params }),
    ...(version !== undefined && { expected_version: version }), ...(query && { query }) });
  const run = (name, args, check, options) => tools.has(name) ? call(name, args, check, options) : undefined;
  const generic = (operation, args, check, options) => call('smartsell_operation_call', { operation, ...args }, check, { operation, ...options });
  const fixture = async (name, args, check, method, path) => await run(name, args, check) ?? await rest(method, path, args.body, args.expected_version);
  const extra = async (section, runSection) => {
    try { await runSection(); } catch (error) { console.log(`${runtime} fixture ${section}: ${error.message}`); }
  };
  const brandKey = randomUUID();
  const brandInput = { body: { name: 'Matrix brand', slug: 'matrix-brand' }, idempotency_key: brandKey };
  const brand = await fixture('workspace_brand_create', brandInput, checkField('name', 'Matrix brand'), 'POST', '/brands');
  const brandId = brand.id;
  if (command) {
    await run('workspace_brand_create', brandInput, checkField('id', brandId), { replay: true, assertion: '同键同参数返回原品牌 ID' });
    await run('workspace_brand_create', { ...brandInput, body: { ...brandInput.body, name: 'Changed input' } }, null,
      { expectedCode: 'IDEMPOTENCY_MISMATCH', assertion: '同键变更输入被拒绝' });
    await run('workspace_brand_create', { body: { name: 'Read only boundary', slug: 'read-only' } }, null,
      { restricted: true, expectedCode: 'TOOL_UNAVAILABLE', assertion: '只读凭据无法创建品牌' });
  } else {
    await run('workspace_brand_get', { workspace_id: randomUUID(), params: { id: brandId } }, null,
      { wire: true, expectedCode: 'NOT_FOUND', assertion: '工作区外的 ID 返回 NOT_FOUND，响应不暴露原工作区品牌' });
  }
  await run('workspace_brand_get', input(null, { id: brandId }), checkField('id', brandId));
  await run('workspace_brand_update', input({ name: 'Matrix brand revised' }, { id: brandId }, brand.version), checkField('name', 'Matrix brand revised'));
  const nextBrand = await rest('POST', '/brands', { name: 'Matrix second brand', slug: 'matrix-second' });
  let next;
  await run('workspace_brands_list', { query: { limit: 1 } }, (data, result) => {
    assert.equal(rows(data).length, 1); assert([brandId, nextBrand.id].includes(rows(data)[0].id));
    assert(result.structuredContent.next_cursor); next = { cursor: result.structuredContent.next_cursor, first: rows(data)[0].id };
  }, { assertion: '第一页返回一个真实品牌，并附下一页游标' });
  if (next) await run('workspace_brands_list', { query: { cursor: next.cursor, limit: 1 } }, hasId(next.first === brandId ? nextBrand.id : brandId),
    { assertion: '第二页返回另一条已创建的品牌' });
  await run('workspace_get_context', {}, contains(brandId));
  let market, store, product, plan, social, item, variant, target, post, adAccount, proposal, link;
  await extra('market', async () => {
    market = await fixture('workspace_market_create', input({ country_code: 'US', primary_language: 'en', currency: 'USD', timezone: 'UTC', name: 'US Matrix' }, { id: brandId }),
      contains('USD'), 'POST', `/brands/${brandId}/markets`);
    await run('workspace_market_update', input({ name: 'US Matrix revised', timezone: 'America/New_York' }, { id: market.id }, market.version), contains('America/New_York'));
    await run('workspace_markets_list', input(null, { id: brandId }), hasId(market.id));
    await run('workspace_market_get', input(null, { id: market.id }), checkField('id', market.id));
  });
  await extra('store and catalog', async () => {
    store = await fixture('commerce_store_create', input({ brand_id: brandId, name: 'Matrix Store', provider: 'shopify', default_currency: 'USD', default_locale: 'en' }),
      checkField('name', 'Matrix Store'), 'POST', '/stores');
    await run('commerce_store_list', {}, hasId(store.id));
    product = await fixture('commerce_product_create', input({ store_id: store.id, title: 'Matrix Catalog Product', status: 'active' }),
      checkField('title', 'Matrix Catalog Product'), 'POST', '/products');
    await run('commerce_product_update', input({ title: 'Matrix Catalog Product revised' }, { id: product.id }, product.version), checkField('title', 'Matrix Catalog Product revised'));
    await run('catalog_search', { query: { store_id: store.id } }, hasId(product.id));
    await run('catalog_get_product', input(null, { id: product.id }), contains(product.id));
    const sku = await run('commerce_variant_create', input({ sku: 'MATRIX-A', options: { size: 'small' } }, { id: product.id }), checkField('sku', 'MATRIX-A'));
    if (sku) {
      await run('commerce_variant_update', input({ sku: 'MATRIX-B' }, { id: sku.id }, sku.version), checkField('sku', 'MATRIX-B'));
      if (market) await extra('manual listing', async () => {
        await rest('PUT', `/stores/${store.id}/markets`, { market_id: market.id, channel: 'online_store', currency: 'USD', enabled: true });
        const listing = await run('commerce_record_listing', input({ market_id: market.id, channel: 'online_store', price_minor: 1230, currency: 'USD', availability: 'observed', inventory_status: 'in_stock' }, { id: sku.id }), contains(sku.id));
        if (listing) await run('market_snapshot', input(null, { id: sku.id }), hasId(listing.id));
      });
    }
  });
  await extra('CSV import', async () => {
    if (!store || !command) return;
    await run('import_template_list', {}, contains('product_list'));
    await run('commerce_store_import', input({ template_key: 'product_list', csv_text: 'Handle,Title,Variant SKU,Variant Price,Currency\nmatrix-store,Matrix Store CSV,MATRIX-STORE,12.30,USD' }, { id: store.id }),
      row => { assert.equal(row.store_id, store.id); assert.equal(row.stats.valid, 1); });
    const batch = await run('import_create', input({ template_key: 'product_list', store_id: store.id,
      csv_text: 'Handle,Heading,Variant SKU,Variant Price,Currency\nmatrix-import,Matrix Imported Product,MATRIX-CSV,12.30,USD' }),
    row => { assert(row.id); assert(row.mapping); });
    if (!batch) return;
    await run('import_get', input(null, { id: batch.id }), checkField('id', batch.id));
    const preview = await run('import_preview', input({ mapping: { ...batch.mapping, Heading: 'title' } }, { id: batch.id }, batch.version),
      row => assert.equal(row.stats.valid, 1));
    if (preview) {
      await run('import_rows', input(null, { id: batch.id }), contains('Matrix Imported Product'));
      await run('import_confirm', input({}, { id: batch.id }), row => { assert.equal(row.status, 'merged'); assert.equal(row.merged_rows, 1); });
    }
  });
  await extra('campaign', async () => {
    if (!command || !product) return;
    plan = await run('campaign_create_draft', input({ brand_id: brandId, name: 'Matrix Plan', kind: 'launch', timezone: 'UTC',
      starts_at: start, ends_at: end, products: [{ product_id: product.id, role: 'hero' }] }), checkField('name', 'Matrix Plan'));
    if (!plan) return;
    await run('campaign_list', {}, hasId(plan.id));
    await run('campaign_get_context', input(null, { id: plan.id }), contains(product.id));
    await run('campaign_set_products', input({ products: [{ product_id: product.id, role: 'hero' }] }, { id: plan.id }, plan.version), contains(product.id));
    const goal = await run('campaign_goal_create', input({ metric_key: 'norm.post.views', unit: 'count', baseline_value: 12,
      baseline_source: 'synthetic fixture', target_value: 100, due_at: end }, { id: plan.id }), checkField('target_value', 100));
    if (goal) {
      await run('campaign_goal_list', input(null, { id: plan.id }), hasId(goal.id));
      await run('campaign_goal_update', input({ target_value: 120, reason: 'Synthetic target adjustment' }, { id: plan.id, goalId: goal.id }, goal.version), checkField('target_value', 120));
    }
    const slot = await run('campaign_plan_slot_create', input({ stage: 'launch', platform: 'youtube', planned_count: 1, locale: 'en' }, { id: plan.id }), checkField('planned_count', 1));
    if (slot) {
      await run('campaign_plan_slot_list', input(null, { id: plan.id }), hasId(slot.id));
      await run('campaign_plan_slot_update', input({ planned_count: 2 }, { id: plan.id, slotId: slot.id }, slot.version), checkField('planned_count', 2));
    }
  });
  await extra('content and publishing', async () => {
    social = await rest('POST', '/social-accounts', { provider: 'meta_facebook', external_account_id: 'matrix-facebook',
      display_name: 'Matrix social', brand_id: brandId, owned_account_confirmed: true });
    await run('account_list_social_accounts', { query: { brand_id: brandId } }, hasId(social.id));
    const made = await fixture('content_create_item', input({ brand_id: brandId, ...(plan && { campaign_id: plan.id }), title: 'Matrix Content' }),
      row => assert.equal(row.item.title, 'Matrix Content'), 'POST', '/content-items');
    item = made.item ?? made;
    await run('content_list', {}, contains(item.id));
    await run('content_get', input(null, { id: item.id }), contains(item.id));
    await run('items_get', input(null, { id: item.id }), contains(item.id));
    const makeVariant = { platform: 'facebook', market: 'US', format: 'text', body_markdown: 'Synthetic initial draft.' };
    await run('content_create_draft', input({ brand_id: brandId, title: 'Matrix Second Draft', variants: [makeVariant] }), contains('Matrix Second Draft'));
    const versioned = await fixture('content_create_variant', input(makeVariant, { id: item.id }), contains('Synthetic initial draft.'), 'POST', `/content-items/${item.id}/variants`);
    variant = versioned.variant ?? versioned;
    await run('content_get_variant', input(null, { id: variant.id }), contains(variant.id));
    const edit = await run('content_autosave_variant', input({ body_markdown: 'Synthetic autosaved draft.', expected_version: variant.version }, { id: variant.id }, variant.version),
      contains('Synthetic autosaved draft.'));
    variant = edit?.variant ?? edit ?? variant;
    const commit = await run('content_commit_revision', input({ expected_version: variant.version, base_revision_id: null }, { id: variant.id }, variant.version),
      row => assert(row.revision?.id));
    if (commit?.revision) {
      variant = commit.variant;
      await run('content_list_revisions', input(null, { id: variant.id }), contains(commit.revision.id));
      const changed = await run('content_update_variant', input({ expected_version: variant.version, base_revision_id: commit.revision.id,
        body_markdown: 'Synthetic second revision.' }, { id: variant.id }, variant.version), contains('Synthetic second revision.'));
      variant = changed?.variant ?? variant;
    }
    target = await fixture('publishing_create_target', input({ social_account_id: social.id, content_variant_id: variant.id, scheduled_at: start }),
      contains(variant.id), 'POST', '/publish-targets');
    await run('publishing_list_targets', {}, hasId(target.id));
    await run('publishing_get_target', input(null, { id: target.id }), checkField('id', target.id));
    if (command) {
      const submitted = await run('publishing_request_approval', input({}, { id: target.id }, target.version), checkField('plan_status', 'awaiting_approval'));
      if (submitted) {
        await run('publishing_list_approvals', { query: { view: 'submitted' } }, contains(target.id));
        await generic('publishing_approve', input({}, { id: target.id }, submitted.version), null,
          { expectedCode: 'HUMAN_REQUIRED', assertion: 'Agent 无法审批发布；由 REST 检查仍在待审批状态' });
        assert.equal((await rest('GET', `/publish-targets/${target.id}`)).plan_status, 'awaiting_approval');
      }
    }
  });
  await extra('posts and observations', async () => {
    if (!command || !social) return;
    const account = await rest('POST', '/social-accounts', { provider: 'youtube', external_account_id: 'matrix-youtube', display_name: 'Matrix YouTube', brand_id: brandId, owned_account_confirmed: true });
    const published = new Date(Date.now() - 86400000).toISOString();
    post = await run('posts_register_manual', input({ social_account_id: account.id, external_post_id: 'labVideo01a',
      permalink: 'https://www.youtube.com/watch?v=labVideo01a', published_at: published }), checkField('verification', 'agent_reported'));
    if (!post) return;
    await run('posts_list', {}, hasId(post.id));
    const from = `${published.slice(0, 10)}T00:00:00.000Z`;
    const to = new Date(Date.parse(from) + 86400000).toISOString();
    await run('analytics_record_observations', { body: { observations: [{ metric_key: 'views', subject_type: 'platform_post', subject_id: post.id,
      period_kind: 'day', period_start: from, period_end: to, observed_at: new Date().toISOString(), value: 29, availability: 'observed', source: { method: 'import', batch_id: 'matrix-metric' } }] } },
      checkField('inserted_count', 1));
    await run('metrics_query', { body: { metrics: ['views'], subject: { type: 'platform_post', filter: { subject_ids: [post.id] } }, time: { from, to } } },
      data => assert.equal(data.rows[0].values.views.value, 29));
    const report = await run('import_create', input({ template_key: 'social_post_report', options: { timezone: 'UTC', social_account_id: account.id },
      csv_text: `external_post_id,report_date,metric_key,value,period_kind\nlabVideo01a,${published.slice(0, 10)},yt.video.views,12,day` }),
    row => assert.equal(row.stats.valid, 1));
    if (report) await run('import_confirm', input({}, { id: report.id }), checkField('merged_rows', 1));
  });
  await extra('ads and inline media', async () => {
    if (!command) return;
    adAccount = await rest('POST', '/ad-accounts', { provider: 'meta_ads', brand_id: brandId, external_account_id: 'act_10001', currency: 'USD', timezone: 'UTC' });
    await run('ads_list_accounts', {}, hasId(adAccount.id));
    await run('ads_import_report', input({ source_ref: 'matrix-ad-fixture', entity: { level: 'campaign', external_id: 'matrix-ad-001', name: 'Matrix imported ad' }, observations: [] }, { id: adAccount.id }), contains('matrix-ad-001'));
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', 'base64');
    const sha256 = createHash('sha256').update(png).digest('hex');
    const ticket = await generic('file_begin_upload', input({ purpose: 'asset', mime_type: 'image/png', original_filename: 'matrix.png', size_bytes: png.length, sha256 }),
      row => { assert(row.id); assert(row.max_inline_bytes >= png.length); assert.equal(row.direct_upload, false); });
    if (!ticket) return;
    const file = await generic('file_complete_upload', input({ base64: png.toString('base64') }, { id: ticket.id }), contains(sha256));
    if (!file) return;
    const asset = await generic('asset_create', input({ brand_id: brandId, file_object_id: file.id, title: 'Matrix image', kind: 'image' }), contains('Matrix image'));
    if (!asset) return;
    const rendition = await rest('POST', `/asset-versions/${asset.asset_version.id}/renditions`, { kind: 'cover' });
    const grant = await rest('POST', '/rights-grants', { brand_id: brandId, grant_type: 'owned', asset_ids: [asset.id], usages: ['paid_ads'], regions: ['US'] });
    await rest('POST', `/rights-grants/${grant.id}/activate`, { confirmed: true }, grant.version);
    const creative = await rest('POST', '/ad-creatives', { brand_id: brandId, origin: 'new',
      variant: { headline: 'Matrix QA', primary_text: 'Synthetic only', locale: 'en', rendition_ids: [rendition.id] } });
    const revision = { objective: 'sales', market_ids: ['US'], creative_variant_ids: [creative.variant.id], schedule: { starts_at: start, ends_at: end },
      budget: { type: 'daily', currency: 'USD', amount_minor: 100, cap_minor: 150 } };
    proposal = await run('ads_create_proposal', input({ name: 'Matrix proposal', campaign_id: plan?.id, ad_account_id: adAccount.id, revision }), contains('Matrix proposal'));
    if (!proposal) return;
    await run('ads_list_proposals', {}, hasId(proposal.id));
    const revised = await run('ads_revise_proposal', input(revision, { id: proposal.id }, proposal.version), row => { assert.equal(row.id, proposal.id); assert.equal(row.status, 'draft'); assert.notEqual(row.current_revision_id, proposal.current_revision_id); });
    if (revised) await run('ads_submit_proposal', input({}, { id: proposal.id }, revised.version), checkField('status', 'in_review'));
    await generic('ads_decide_proposal', input({ decision: 'approved' }, { id: proposal.id }), null, { expectedCode: 'HUMAN_REQUIRED' });
  });
  await extra('standalone assets', async () => {
    if (command) return;
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', 'base64');
    const sha256 = createHash('sha256').update(png).digest('hex');
    const ticket = await rest('POST', '/files/uploads', { purpose: 'asset', mime_type: 'image/png', original_filename: 'matrix.png', size_bytes: png.length, sha256 });
    const file = await rest('POST', `/files/uploads/${ticket.id}/complete`, { base64: png.toString('base64') });
    const asset = await rest('POST', '/assets', { brand_id: brandId, file_object_id: file.id, title: 'Matrix standalone asset', kind: 'image' });
    await run('asset_search', { query: { q: 'Matrix' } }, contains(asset.id));
    await run('asset_get', { params: { id: asset.id } }, contains(asset.id));
    await run('asset_list_versions', { params: { id: asset.id } }, contains(asset.current_version_id));
  });
  await extra('inbox leases and send permission', async () => {
    if (!tools.has('inbox_claim') || !social) return;
    const inbound = { brand_id: brandId, social_account_id: social.id, provider: 'meta_facebook', external_message_id: 'matrix-comment',
      kind: 'comment_thread', external_user_id: 'synthetic-participant', display_name: 'Matrix participant',
      external_url: 'https://example.com/local-fixture-comment', body_text: 'Matrix inbound fixture', platform_created_at: new Date(Date.now() - 2000).toISOString() };
    await rest('POST', '/inbox/ingest', { messages: [inbound] });
    const [conversation] = rows(await rest('GET', '/conversations'));
    assert(conversation?.id);
    const claim = await run('inbox_claim', input({ purpose: 'review' }, { id: conversation.id }), row => {
      assert.equal(row.conversation_id, conversation.id); assert(Number.isSafeInteger(row.fencing_token));
    });
    if (claim) await run('inbox_release', input({ fencing_token: claim.fencing_token }, { id: conversation.id }), checkField('released', true));
    const draft = await rest('POST', `/conversations/${conversation.id}/reply-drafts`, { body_text: 'Synthetic unsent reply' });
    await run('inbox_send_reply', input({}, { id: draft.id }, draft.version), null,
      { expectedCode: 'LEASE_HELD', nativeDenied: true, assertion: '无有效回复租约时拒绝发送' });
    const replyLease = await run('inbox_claim', input({ purpose: 'reply' }, { id: conversation.id }), row => {
      assert.equal(row.conversation_id, conversation.id); assert.equal(row.purpose, 'reply');
    });
    if (replyLease) {
      await run('inbox_send_reply', input({ fencing_token: replyLease.fencing_token, mode: 'manual' }, { id: draft.id }, draft.version), null,
        { expectedCode: 'APPROVAL_REQUIRED', nativeInline: true, assertion: '持有效回复租约仍不能提交未审批草稿' });
      await run('inbox_release', input({ fencing_token: replyLease.fencing_token }, { id: conversation.id }), checkField('released', true));
    }
    assert.equal((await rest('GET', `/reply-drafts/${draft.id}`)).status, 'editing');
  });
  await extra('tracked links', async () => {
    if (!command) return;
    const domain = await seed('link_domain', { hostname: 'matrix.example.com', verification_status: 'verified', tls_status: 'active' });
    await rest('POST', '/redirect-allowlist', { hostname: 'example.com' });
    const destination = { domain_id: domain.id, code: 'matrix-synthetic', destination_url: 'https://example.com/fixture', brand_id: brandId };
    link = await run('links_create', input(destination), contains('matrix-synthetic'));
    if (link) await run('links_list', {}, hasId(link.id));
    await run('links_batch', input({ dry_run: true, links: [{ ...destination, code: 'matrix-preview' }] }), contains('matrix-preview'));
  });
  await extra('agent jobs', async () => {
    const job = await rest('POST', '/agent-jobs', { title: 'Matrix synthetic delegation' });
    const second = await rest('POST', '/agent-jobs', { title: 'Matrix synthetic handoff' });
    if (legacyOnly.some(tool => tool.name === 'jobs_get')) {
      await call('jobs_get', { workspace_id: ws, operation_id: job.id }, data => {
        assert.equal(data.operation_id, job.id); assert.equal(data.status, 'open');
      }, { restricted: true, sdkOutputCheck: true, assertion: '旧式只读 PAT 可读取正常交办任务的持久操作 ID 与 open 状态' });
    }
    if (tools.has('jobs_get')) await run('jobs_get', { params: { id: job.id } }, contains(job.id));
    if (tools.has('jobs_cancel')) {
      const cancel = await rest('POST', '/agent-jobs', { title: 'Matrix cancellation fixture' });
      await run('jobs_cancel', { params: { id: cancel.id }, expected_version: cancel.version }, contains('cancelled'));
    }
    if (tools.has('agent_jobs_confirm_cancel')) {
      const cancel = await rest('POST', '/agent-jobs', { title: 'Matrix confirm cancellation fixture' });
      const claimed = await run('agent_jobs_claim', input({}, { id: cancel.id }, cancel.version), row => assert(Number.isSafeInteger(row.fencing_token)));
      if (claimed) {
        const requested = await rest('POST', `/agent-jobs/${cancel.id}/cancel`, {}, claimed.version);
        await run('agent_jobs_confirm_cancel', input({ fencing_token: claimed.fencing_token }, { id: cancel.id }, requested.version), checkField('status', 'cancelled'));
      }
    }
    await run('agent_jobs_list', { query: { status: 'open' } }, hasId(job.id));
    await run('agent_jobs_get', input(null, { id: job.id }), checkField('id', job.id));
    const lease = await run('agent_jobs_claim', input({}, { id: job.id }, job.version), row => assert(Number.isSafeInteger(row.fencing_token)));
    if (lease) {
      await run('agent_jobs_heartbeat', input({ fencing_token: lease.fencing_token + 1, progress_note: 'stale lease boundary' }, { id: job.id }, lease.version),
        null, { expectedCode: 'LEASE_LOST', nativeInline: true });
      const beat = await run('agent_jobs_heartbeat', input({ fencing_token: lease.fencing_token, progress_note: 'Local fixture checked' }, { id: job.id }, lease.version), contains('Local fixture checked'));
      if (beat) await run('agent_jobs_submit_result', input({ fencing_token: beat.fencing_token, result_ref: { note: 'Synthetic receipt' } }, { id: job.id }, beat.version),
        data => { assert.equal(data.status, 'submitted'); assert.equal(data.result_ref.note, 'Synthetic receipt'); });
    }
    const lease2 = await run('agent_jobs_claim', input({}, { id: second.id }, second.version), row => assert(Number.isSafeInteger(row.fencing_token)));
    if (lease2) await run('agent_jobs_handoff', input({ fencing_token: lease2.fencing_token, done_summary: 'Synthetic local handoff' }, { id: second.id }, lease2.version),
      data => assert(['open', 'blocked', 'needs_human'].includes(data.status), `handoff state ${data.status}`));
  });
  await extra('work-item inspection', async () => {
    if (!tools.has('tasks_get')) return;
    const task = await rest('POST', '/work-items', { title: 'Matrix work item' });
    await run('tasks_get', input(null, { id: task.id }), contains(task.id));
  });
  await extra('approved intel and search', async () => {
    const outputCheck = { sdkOutputCheck: true };
    const board = await rest('POST', '/research-boards', { title: 'Matrix research board' });
    const watch = await rest('POST', '/watch-targets', { name: 'Matrix watch', target_type: 'keyword', query: { keywords: ['matrix'] } });
    const observation = await rest('POST', '/observations', { watch_target_id: watch.id, subject_type: 'post',
      url: 'https://example.com/matrix-observation', observed_at: new Date(Date.now() - 1000).toISOString(), note: 'Matrix observed evidence' });
    const citation = await rest('POST', `/research-boards/${board.id}/items`, { item_type: 'observation', ref_id: observation.id });
    const noteBody = { title: 'Matrix research note', body: 'Synthetic offline research', stance: 'evidence', evidence_refs: [citation.id] };
    const note = await run('research_create_note', command ? { workspace_id: ws, board_id: board.id, ...noteBody } : input(noteBody, { id: board.id }),
      row => { assert(row.id); assert.equal(row.stance, 'evidence'); }, { ...outputCheck, ...(command && { nativeInput: () => ({ workspace_id: ws, board_id: board.id, ...noteBody, title: 'Matrix native research note' }) }) });
    const lookup = { kind: 'observation', id: observation.id };
    const lookupArgs = command ? { workspace_id: ws, ...lookup } : { query: lookup };
    await run('research_search', lookupArgs, contains(observation.id), { assertion: '验证通用 callTool 对声明输出 schema 的兼容性' });
    if (note) await run('research_item_evidence', command ? { workspace_id: ws, research_item_id: note.id } : input(null, { id: note.id }),
      data => { assert.equal(data.item.id, note.id); assert(data.evidence.some(row => row.id === observation.id)); }, outputCheck);
    const creative = await rest('POST', '/creative-references', { url: observation.url, observation_id: observation.id, structure: { format: 'Human format' } });
    const structure = { topic: 'Matrix synthetic creative' };
    const annotation = await run('creative_reference_annotate', command ? { workspace_id: ws, creative_reference_id: creative.id, expected_version: creative.version, structure } :
      input({ structure }, { id: creative.id }, creative.version), row => { assert.equal(row.id, creative.id); assert.equal(row.version, creative.version + 1); }, { ...outputCheck, ...(command && { nativeInput: row => ({ workspace_id: ws, creative_reference_id: creative.id, expected_version: row.version, structure: { topic: 'Matrix native creative annotation' } }) }) });
    if (annotation) {
      const persisted = rows(await rest('GET', '/creative-references')).find(row => row.id === creative.id);
      assert.equal(persisted.structure.topic, structure.topic);
    }
    await run('search_query', { ...(command && { workspace_id: ws }), query: { q: 'Matrix' } }, contains(brandId), outputCheck);
  });
  await extra('approved knowledge', async () => {
    const outputCheck = { sdkOutputCheck: true };
    const entry = await rest('POST', '/knowledge', { brand_id: brandId, kind: 'tone', title: 'Matrix approved knowledge', body: 'Matrix approved fixture text' });
    const revision = entry.knowledge_revision;
    await rest('POST', `/knowledge-revisions/${revision.id}/approve`, {}, revision.version);
    const args = { params: { brandId }, ...(command && { workspace_id: ws }) };
    await run('knowledge_get_context', args, contains(revision.id), outputCheck);
    await run('agent_preview_context', { ...args, query: { q: 'Matrix approved' } }, contains(revision.id), outputCheck);
    if (!product) return;
    const fact = await rest('POST', `/products/${product.id}/facts`, { fact_key: 'matrix-material', category: 'spec', value: 'Matrix material' });
    await rest('POST', `/fact-revisions/${fact.current_revision_id}/approve`, {});
    await run('catalog_list_facts', { params: { id: product.id }, ...(command && { workspace_id: ws }) }, contains('matrix-material'), outputCheck);
  });
  await extra('desktop capability receipt', async () => {
    if (!product || !store) return;
    const body = { capability: 'product_listing', product_id: product.id, store_id: store.id };
    const requestSchema = tools.get('desktop_request_capability')?.inputSchema;
    const args = requestSchema?.properties?.capability ? { ...body, idempotency_key: randomUUID() } : { body, idempotency_key: randomUUID() };
    const receipt = await run('desktop_request_capability', args, row => {
      assert.equal(row.status, 'unsupported'); assert.equal(row.reason, 'product_listing_not_supported'); assert.equal(row.product_id, product.id);
    });
    const getSchema = tools.get('desktop_get_capability_request')?.inputSchema;
    if (receipt) await run('desktop_get_capability_request', getSchema?.properties?.id ? { id: receipt.id } : { params: { id: receipt.id } }, checkField('id', receipt.id));
  });
  await extra('paired synthetic worker', async () => {
    if (!tools.has('zhihu_stats_create') && !tools.has('account_list_devices')) return;
    const deviceId = await pair();
    await run('account_list_devices', {}, contains(deviceId));
    const queued = await run('zhihu_stats_create', input({ device_id: deviceId, mode: 'login_check' }), row => {
      assert.equal(row.status, 'queued'); assert.equal(row.device_id, deviceId);
    });
    if (queued) await run('zhihu_stats_get', { params: { id: queued.id } }, row => {
      assert.equal(row.id, queued.id); assert.equal(row.status, 'queued');
    });
  });
  await extra('fixed Worker catalog', async () => {
    if (!tools.has('worker_catalog_list') && !tools.has('worker_catalog_request_import')) return;
    const externalId = 'matrix-worker-shop.myshopify.com';
    const workerStore = await rest('POST', '/stores', { brand_id: brandId, name: 'Matrix Worker Store', provider: 'shopify',
      external_store_id: externalId, default_currency: 'USD', default_locale: 'en-US' });
    const workerId = await pair();
    const binding = { device_id: workerId, external_store_id: externalId };
    const bound = await rest('PUT', `/stores/${workerStore.id}/worker`, binding);
    assert.equal(bound.device_id, workerId);
    assert.equal(bound.external_store_id, externalId);
    if (tools.has('smartsell_operation_call')) {
      await generic('worker_catalog_bind', input(binding, { id: workerStore.id }), null,
        { expectedCode: 'HUMAN_REQUIRED', assertion: 'Worker 绑定只能由具有权限的人通过 Web 提交' });
    }
    const queued = await run('worker_catalog_request_import', input({}, { id: workerStore.id }), row => {
      assert(row.id);
      assert.equal(row.status, 'queued');
      assert.equal(row.store_id, workerStore.id);
      assert.equal(row.device_id, workerId);
    });
    await run('worker_catalog_list', {}, data => {
      assert(data.bindings.some(row => row.store_id === workerStore.id && row.device_id === workerId && row.external_store_id === externalId));
      if (tools.has('worker_catalog_request_import')) {
        assert(queued, 'Expected a queued fixture import');
        assert(data.jobs.some(row => row.id === queued.id && row.store_id === workerStore.id && row.device_id === workerId && row.status === 'queued'));
      }
    });
  });
  await extra('workflow templates and changes', async () => {
    if (tools.has('workflow_templates_list')) {
      const template = await rest('POST', '/workflow-templates', { key: 'matrix-template', name: 'Matrix template', prompt: 'Read a synthetic title', steps: ['Read title'] });
      await run('workflow_templates_list', {}, hasId(template.id));
      await run('workflow_templates_get', { params: { id: template.id } }, contains('Read a synthetic title'));
    }
    if (tools.has('change_sets_create')) {
      const task = await rest('POST', '/work-items', { title: 'Matrix change set target' });
      const proposal = await run('change_sets_create', { body: { title: 'Matrix proposed edit', rationale: 'Local-only approval fixture',
        items: [{ target_type: 'work_item', target_id: task.id, expected_version: task.version, patch: { title: 'Matrix proposed text' } }] } },
        row => { assert.equal(row.status, 'pending'); assert.equal(row.items[0].target_id, task.id); });
      if (proposal) await run('change_sets_get', { params: { id: proposal.id } }, contains('Matrix proposed text'));
    }
  });
  if (command) {
    const views = {
      views_home: [{}, target?.id ?? plan?.id ?? brandId], views_products_list: [{}, product?.id],
      views_product_get: [{ params: { id: product?.id } }, product?.id], views_plans_list: [{}, plan?.id],
      views_plan_get: [{ params: { id: plan?.id } }, plan?.id], views_calendar: [{ query: { from: start.slice(0, 10), to: end.slice(0, 10) } }, target?.id],
      views_social: [{}, social?.id], views_ads: [{}, adAccount?.id], views_decisions_list: [{}, target?.id],
      views_activity: [{}, 'desktop_request_capability'], views_agent_presence: [{}, 'last_seen_at'],
    };
    for (const [name, [args, marker]] of Object.entries(views)) if (marker) await run(name, args, contains(marker));
    await run('views_decisions_summary', {}, data => assert(Object.values(data).some(n => Number.isInteger(n) && n > 0), 'Expected pending decisions'));
    const index = await run('smartsell_operations_describe', {}, data => assert(rows(data).some(row => row.module === 'workspace' && row.operations > 0)));
    for (const { module, operations } of rows(index)) {
      await run('smartsell_operations_describe', { module }, data => {
        assert.equal(rows(data).length, operations); assert(rows(data).every(row => row.name && row.method && row.path));
      }, { assertion: `枚举 ${module} 模块的 ${operations} 项授权操作` });
    }
    await generic('workspace_brand_get', input(null, { id: brandId }), checkField('id', brandId));
    if (market) await generic('workspace_market_get', input(null, { id: market.id }), checkField('id', market.id));
    if (product) await generic('commerce_product_usage', input(null, { id: product.id }), data => {
      assert(plan); assert(JSON.stringify(data).includes(plan.id), 'Expected usage by the fixture campaign');
    });
  }
}

export async function fallback({ tools, call, runtime, ws }, calls) {
  for (const tool of tools.values()) {
    if (calls.some(item => item.name === tool.name)) continue;
    // Uncovered writes stay unexecuted unless they have reviewed, domain-specific arguments above.
    if (!tool.annotations?.readOnlyHint || tool.annotations.openWorldHint) continue;
    const required = (tool.inputSchema.required ?? []).filter(name => name !== 'workspace_id');
    if (required.length) continue;
    const args = runtime === 'operations' ? { workspace_id: ws } : {};
    await call(tool.name, args, () => { throw new Error('No fixture-specific business invariant is available for this read'); },
      { assertion: '记录安全读取的实际回执。缺少夹具业务断言时不计入通过。' });
  }
}
