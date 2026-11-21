import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consentFor, recordLeadConsent } from './consent.js';
import { operations, recordLeadConsents } from './index.js';
import { testWorkspace } from './workspace-test-context.js';

function fixture() {
  const workspace = testWorkspace(operations);
  const {ctx,call} = workspace;
  const emailText = call('lifecycle_create_consent_text',{channel:'email',purpose:'marketing',locale:'en',text:'Email promotions'});
  const smsText = call('lifecycle_create_consent_text',{channel:'sms',purpose:'marketing',locale:'en',text:'SMS promotions'});
  const {customer,records} = recordLeadConsents(ctx,{leadId:'lead-1',formVersionId:'form-v1',brandId:'brand',choices:[
    {channel:'email',purpose:'marketing',consent_text_version_id:emailText.id},
    {channel:'sms',purpose:'marketing',consent_text_version_id:smsText.id},
  ]});
  return {...workspace,customer,records,emailText,smsText};
}

test('traffic consent is append-only, channel-specific and purpose-specific', () => {
  const {ctx,call,customer,records,emailText} = fixture();
  assert.equal(records[0].source_ref,'form-v1');
  assert.equal(records[0].lead_id,'lead-1');
  assert.equal(ctx.list('customer_identity')[0].verified,false);
  recordLeadConsent(ctx,{lead_id:'lead-2',source_ref:'form-v1',channel:'email',purpose:'service'});
  assert.equal(consentFor(ctx,customer.id,'email','service').state,'unknown');
  call('lifecycle_record_consent',{channel:'email',purpose:'marketing',source:'unsubscribe_link',action:'withdrawn',source_ref:'ref',evidence_ids:['receipt']},customer.id);
  assert.equal(consentFor(ctx,customer.id,'email','marketing').state,'opted_out');
  assert.equal(consentFor(ctx,customer.id,'sms','marketing').state,'opted_in');
  assert.equal(records[0].action,'opt_in');
  ctx.now = '2026-11-19T12:01:00.000Z';
  call('lifecycle_record_consent',{channel:'email',purpose:'marketing',source:'esp',action:'imported_state',source_ref:'source',imported_state:'opted_in'},customer.id);
  assert.equal(consentFor(ctx,customer.id,'email','marketing').state,'opted_out');
  call('lifecycle_record_consent',{channel:'email',purpose:'marketing',source:'support_request',action:'opt_in',source_ref:'ref2',evidence_ids:['receipt2'],consent_text_version_id:emailText.id},customer.id);
  assert.equal(consentFor(ctx,customer.id,'email','marketing').state,'opted_in');
  assert.throws(() => recordLeadConsent(ctx,{lead_id:'lead-3',source_ref:'form-v1',channel:'sms',purpose:'marketing',consent_text_version_id:emailText.id}),{code:'INVALID_INPUT'});
});

test('segments re-evaluate suppression and frequency while keeping snapshots immutable and aggregate-only', () => {
  const {ctx,call,customer} = fixture();
  const segment = call('segments_create',{brand_id:'brand',name:'Email',required_consent:{channel:'email',purpose:'marketing'}});
  const initial = call('segments_preview',{},segment.id);
  assert.equal(initial.eligible_count,1);
  const suppression = {customer_id:customer.id,channel:'email',reason:'bounce',source:'esp',source_ref:'report'};
  call('lifecycle_record_suppression',suppression);
  const blocked = call('segments_preview',{},segment.id);
  assert.equal(blocked.eligible_count,0);
  assert.deepEqual(blocked.excluded,{suppressed:1});
  assert.equal(ctx.get('segment_snapshot',initial.id).eligible_count,1);
  assert.equal(blocked.member_ids,undefined);
  call('lifecycle_record_suppression',{...suppression,active:false});
  const account = call('lifecycle_create_esp_account',{provider:'klaviyo',external_account_id:'ext',channel:'email',brand_id:'brand',is_sending_system_of_record:true});
  call('lifecycle_create_frequency_rule',{channel:'email',scope:'brand',brand_id:'brand',max_per_window:1,window_hours:24});
  call('lifecycle_import_send_observation',{esp_account_id:account.id,customer_id:customer.id,external_send_id:'send-1',sent_at:ctx.now});
  const limited = call('segments_preview',{},segment.id);
  assert.deepEqual(limited.excluded,{frequency:1});
  assert.equal(limited.frequency_coverage,'observed_esp_sends_only');
});

test('ESP local campaign plans stay separate from external scheduling and flow status', () => {
  const {ctx,call} = fixture();
  const segment = call('segments_create',{brand_id:'brand',name:'Marketing',required_consent:{channel:'email',purpose:'marketing'}});
  const settings = {provider:'klaviyo',external_account_id:'ext',channel:'email',brand_id:'brand',is_sending_system_of_record:true};
  const account = call('lifecycle_create_esp_account',settings);
  assert.throws(() => call('lifecycle_create_esp_account',{...settings,external_account_id:'ext-2'}),{code:'STATE_CONFLICT'});
  const campaign = call('lifecycle_create_campaign_draft',{esp_account_id:account.id,segment_version_id:segment.current_version_id,template_ref:'template',planned_send_at:'2026-12-01T00:00:00Z'});
  assert.equal(call('lifecycle_export_campaign',{},campaign.id).mode,'manual');
  const task = call('lifecycle_schedule_campaign',{},campaign.id);
  assert.equal(task.status, 'manual_required');
  assert.equal(call('lifecycle_schedule_campaign',{},campaign.id).work_item_id, task.work_item_id);
  assert.equal(ctx.list('work_item').length, 1);
  assert.equal(ctx.get('esp_campaign_ref',campaign.id).status,'draft');
  assert.equal(ctx.list('segment_snapshot')[0].purpose,'schedule_estimate');
  const flow = call('lifecycle_create_flow_draft',{esp_account_id:account.id,kind:'abandoned_cart',trigger:'cart_abandoned'});
  assert.equal(call('lifecycle_change_flow_status',{status:'manual'},flow.id).review_mode,'manual');
  assert.throws(() => call('lifecycle_change_flow_status',{status:'live'},flow.id),{code:'CAPABILITY_UNAVAILABLE'});
  assert.equal(ctx.get('esp_flow_ref',flow.id).status,'draft');
});

test('an expired double opt-in confirmation and arbitrary DTO fields do not grant eligibility', () => {
  const {ctx,call,emailText} = fixture();
  const customer = call('customers_create',{brand_id:'brand'});
  const common = {channel:'email',purpose:'marketing',source:'support_request',source_ref:'source',evidence_ids:['e1']};
  call('lifecycle_record_consent',{...common,action:'opt_in',consent_text_version_id:emailText.id,requires_double_opt_in:true,pending_until:'2026-11-19T12:05:00Z'},customer.id);
  assert.equal(consentFor(ctx,customer.id,'email','marketing').state,'pending');
  ctx.now = '2026-11-19T12:06:00.000Z';
  call('lifecycle_record_consent',{...common,action:'double_opt_in_confirmed'},customer.id);
  assert.equal(consentFor(ctx,customer.id,'email','marketing').state,'unknown');
  assert.throws(() => call('customers_create',{display_name_encrypted:'injected'}),{code:'INVALID_INPUT'});
});
