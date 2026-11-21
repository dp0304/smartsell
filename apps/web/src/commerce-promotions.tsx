import { useState } from 'react';
import { asRecord, type RecordData } from '@smartsell/sdk';
import { findOperation, ProblemNotice, recordRows, stringValue, useApi, useRead, versionOf } from './api';
import { CommerceForm } from './commerce-workbench';
import { useCopy } from './i18n';

export function PromotionCreate({ onCreated }: { onCreated: (id: string) => void }) {
  const api = useApi();
  const { label } = useCopy();
  const [open, setOpen] = useState(false);
  const stores = useRead('/stores', [], api.brandId ? { brand_id: api.brandId } : {}, 'commerce');
  if (!findOperation(api, 'POST', '/promotions', 'commerce')) return null;
  const title = label(['建立促銷草稿', 'Create promotion draft', '创建促销草稿']);
  return <><button className="primary" onClick={() => setOpen(true)}>{title}</button>
    {open && <CommerceForm path="/promotions" title={title} close={() => setOpen(false)} saved={row => onCreated(stringValue(row.id))}
      body={fields => ({
        store_id: String(fields.get('store')), name: String(fields.get('name')), state: 'draft',
        rule: { percent_off: Number(fields.get('percent')) }, codes: [{ code: String(fields.get('code')) }],
        external_discount_id: String(fields.get('offer')).trim() || null,
        valid_from: new Date(`${String(fields.get('from'))}Z`).toISOString(), valid_until: new Date(`${String(fields.get('until'))}Z`).toISOString(),
      })}>
      {stores.isError && <ProblemNotice error={stores.error} />}
      <label className="field">{label(['店鋪', 'Store', '店铺'])}<select name="store" aria-label={label(['店鋪', 'Store', '店铺'])} defaultValue="" required>
        <option value="">{label(['選擇店鋪', 'Select a store', '选择店铺'])}</option>
        {(recordRows(stores.data?.data) ?? []).filter(row => row.status !== 'disabled').map(row => <option key={stringValue(row.id)} value={stringValue(row.id)}>{stringValue(row.name)}</option>)}
      </select></label>
      <label className="field">{label(['促銷名稱', 'Promotion name', '促销名称'])}<input name="name" required /></label>
      <label className="field">{label(['折扣百分比', 'Discount percent'])}<input type="number" name="percent" min="1" max="100" required /></label>
      <label className="field">{label(['優惠碼', 'Discount code', '优惠码'])}<input name="code" maxLength={128} required /></label>
      <label className="field">{label(['外部優惠 ID', 'External discount ID', '外部优惠 ID'])}<input name="offer" placeholder="gid://shopify/DiscountCodeNode/123" /></label>
      <label className="field">{label(['有效起始（UTC）', 'Valid from (UTC)'])}<input name="from" type="datetime-local" step="1" required /></label>
      <label className="field">{label(['有效結束（UTC）', 'Valid until (UTC)', '有效结束（UTC）'])}<input name="until" type="datetime-local" step="1" required /></label>
      <p>{label(['只儲存內部草稿；不會在店鋪建立優惠。', 'Saves an internal draft only. It does not create a store discount.', '只保存内部草稿；不会在店铺创建优惠。'])}</p>
    </CommerceForm>}
  </>;
}

export function PromotionDetail({ record }: { record: RecordData }) {
  const api = useApi();
  const { label } = useCopy();
  const [form, setForm] = useState<'schedule' | 'link' | 'verify' | 'copy'>();
  const [copy, setCopy] = useState<RecordData>();
  const ids = [stringValue(record.id)];
  const version = versionOf(record);
  const state = String(record.state);
  const percent = stringValue(asRecord(record.rule).percent_off);
  const codes = (recordRows(record.codes) ?? []).map(row => stringValue(row.code));
  const verified = record.offer_verified === true;
  const mismatch = record.verification_status === 'mismatch';
  const stateNames = { draft: label(['草稿', 'Draft']), scheduled: label(['已排程', 'Scheduled', '已调度']), active: label(['生效', 'Active']), expired: label(['已過期', 'Expired', '已过期']), cancelled: label(['已取消', 'Cancelled']) };
  const canVerify = Boolean(record.external_discount_id && findOperation(api, 'POST', '/promotions/:id/verify', 'commerce'));
  const conflicts = copy?.version === record.version && Array.isArray(copy?.copy_conflicts) && (copy.copy_conflicts.length > 0 || verified) ? copy.copy_conflicts : null;
  const evidence = label(['促銷證據', 'Promotion evidence', '促销证据']);
  const schedule = label(['啟用促銷計畫', 'Enable promotion plan', '激活促销计划']);
  const editLink = record.external_discount_id ? label(['更改店鋪優惠連結', 'Change store offer link', '更改店铺优惠链接']) : label(['連結店鋪優惠', 'Link store offer', '链接店铺优惠']);
  const canUpdate = Boolean(findOperation(api, 'PATCH', '/promotions/:id', 'commerce'));
  const verify = label(['核對店鋪優惠', 'Verify store offer', '核对店铺优惠']);
  const check = label(['檢查渠道文案', 'Check channel copy', '检查渠道文案']);
  return <section aria-label={evidence} className="message">
    <h3>{evidence}</h3>
    <dl>
      <dt>{label(['計畫狀態', 'Plan state', '计划状态'])}</dt><dd>{stateNames[state as keyof typeof stateNames] ?? state}</dd>
      <dt>{label(['店鋪回讀', 'Store readback', '店铺回读'])}</dt><dd>{verified ? label(['已驗證生效', 'Verified active', '已验证生效']) : mismatch ? label(['優惠不符或無法核對', 'Mismatch or unverifiable offer', '优惠不符或无法核对']) : label(['未驗證生效', 'Not verified active', '未验证生效'])}</dd>
      <dt>{label(['已觀測的優惠使用訂單', 'Observed coupon orders', '已观测的优惠使用订单'])}</dt><dd>{stringValue(record.usage_count) || '0'}</dd>
      {!!percent && <><dt>{label(['計畫折扣', 'Planned discount', '计划折扣'])}</dt><dd>{percent}%</dd></>}
      {!!codes.length && <><dt>{label(['計畫優惠碼', 'Planned codes', '计划优惠码'])}</dt><dd>{codes.join(', ')}</dd></>}
      <dt>{label(['有效期間（UTC）', 'Validity window (UTC)', '有效期间（UTC）'])}</dt><dd>{stringValue(record.valid_from)} – {stringValue(record.valid_until)}</dd>
    </dl>
    {mismatch && <p role="alert">{label(['店鋪優惠與計畫不一致或無法核對。請勿宣傳為已生效。', 'Store offer differs from the plan or cannot be verified. Do not advertise it as active.', '店铺优惠与计划不一致或无法核对。请勿宣传为已生效。'])}</p>}
    {state === 'draft' && canUpdate && <button onClick={() => setForm('schedule')}>{schedule}</button>}
    {state !== 'cancelled' && canUpdate && <button onClick={() => setForm('link')}>{editLink}</button>}
    {canVerify && <><button onClick={() => { setCopy(undefined); setForm('verify'); }}>{verify}</button> <button onClick={() => { setCopy(undefined); setForm('copy'); }}>{check}</button></>}
    {conflicts && (conflicts.length ? <div className="problem" role="alert">
      <strong>{label(['文案與店鋪優惠不一致', 'Copy conflicts with the store offer', '文案与店铺优惠不一致'])}</strong>
      {conflicts.includes('percent_off') && <p>{label(['宣傳的折扣百分比不符。', 'The advertised discount percentage differs.', '宣传的折扣百分比不符。'])}</p>}
      {conflicts.includes('code') && <p>{label(['宣傳的優惠碼不符。', 'The advertised discount code differs.', '宣传的优惠码不符。'])}</p>}
      {conflicts.includes('offer_unverified') && <p>{label(['無法確認優惠已生效並與計畫一致。', 'The offer is not verified active and aligned with the plan.', '无法确认优惠已生效并与计划一致。'])}</p>}
    </div> : <p role="status">{label(['宣傳的優惠碼及折扣與已驗證的優惠相符。', 'The advertised code and discount match the verified offer.', '宣传的优惠码及折扣与已验证的优惠相符。'])}</p>)}
    {form === 'schedule' && <CommerceForm method="PATCH" path="/promotions/:id" ids={ids} version={version} title={schedule} body={() => ({ state: 'scheduled' })} close={() => setForm(undefined)}>
      <p>{label(['依有效期間啟用內部計畫，不會更改店鋪優惠。', 'Enables the internal plan based on its validity window. Does not change the store discount.', '依有效期间激活内部计划，不会更改店铺优惠。'])}</p>
    </CommerceForm>}
    {form === 'link' && <CommerceForm method="PATCH" path="/promotions/:id" ids={ids} version={version} title={editLink}
      body={fields => ({ external_discount_id: String(fields.get('offer')).trim() || null })} close={() => setForm(undefined)}>
      <label className="field">{label(['外部優惠 ID', 'External discount ID', '外部优惠 ID'])}<input name="offer" defaultValue={stringValue(record.external_discount_id)} placeholder="gid://shopify/DiscountCodeNode/123" /></label>
    </CommerceForm>}
    {(form === 'verify' || form === 'copy') && <CommerceForm path="/promotions/:id/verify" ids={ids} version={version} title={form === 'verify' ? verify : check}
      body={fields => form === 'copy' ? { copy_claim: { code: String(fields.get('code')), percent_off: Number(fields.get('percent')) } } : {}}
      close={() => setForm(undefined)} saved={setCopy}>
      <p>{form === 'copy' ? label(['輸入渠道文案所宣傳的優惠碼及折扣百分比，並與店鋪即時回讀核對。', 'Enter the code and percentage advertised in channel copy to check them against a fresh store readback.', '输入渠道文案所宣传的优惠码及折扣百分比，并与店铺实时回读核对。']) : label(['從已授權的店鋪讀回優惠，不會更改店鋪優惠。', 'Reads the offer from the authorized store without changing it.', '从已授权的店铺读回优惠，不会更改店铺优惠。'])}</p>
      {form === 'copy' && <>
        <label className="field">{label(['宣傳優惠碼', 'Advertised code', '宣传优惠码'])}<input name="code" defaultValue={codes[0]} required maxLength={128} /></label>
        <label className="field">{label(['宣傳折扣百分比', 'Advertised discount percent', '宣传折扣百分比'])}<input type="number" name="percent" defaultValue={percent} min="1" max="100" required /></label>
      </>}
    </CommerceForm>}
  </section>;
}
