import { useRef, useState, type FormEvent } from 'react';
import type { Tuple } from '@smartsell/ui';
import { useView } from '../data/use-view';
import { Loaded, useText } from '../parts';
import { Field, WriteProblem } from './settings-parts';
import { useSetupWrite, type Store } from './setup-data';

const channels = {
  online_store: ['網路商店', 'Online store', '网络商店'],
  tiktok_shop: ['TikTok Shop', 'TikTok Shop'],
  marketplace: ['電商平台', 'Marketplace', '电商平台'],
  other: ['其他', 'Other'],
} as const satisfies Record<string, Tuple>;
type Channel = keyof typeof channels;

const text = {
  title: ['首次匯入的價格與庫存', 'Prices and stock for the first import', '首次导入的价格与库存'],
  intro: ['選擇市場和銷售渠道，讓商品清單中的店鋪基礎價與庫存顯示在商品看板。', 'Choose a market and sales channel to show the export’s base prices and stock in Products.', '选择市场和销售渠道，让商品清单中的店铺基础价与库存显示在商品看板。'],
  values: ['使用來源檔案的價格與庫存數量。空白價格顯示為未採集，空白庫存顯示為未知。價格 0 仍是價格，庫存 0 表示缺貨。', 'Prices and quantities come from the export. Blank prices show as not collected and blank quantities as unknown. A zero price is shown as zero, and a zero quantity means out of stock.', '使用来源文件的价格与库存数量。空白价格显示为未采集，空白库存显示为未知。价格 0 仍是价格，库存 0 表示缺货。'],
  missing: ['店鋪需要有品牌及預設幣別才能在這裡設定市場。', 'The store needs a brand and default currency to set up a market here.', '店铺需要有品牌及预设币别才能在这里设置市场。'],
  disabled: ['此店鋪已停用。', 'This store is disabled.', '此店铺已禁用。'],
  market: ['市場', 'Market', '市场'],
  channel: ['銷售渠道', 'Sales channel', '销售渠道'],
  name: ['市場名稱', 'Market name', '市场名称'],
  country: ['國家代碼（兩個英文字母）', 'Country code (two letters)', '国家代码（两个英文字母）'],
  locale: ['市場語言', 'Market locale', '市场语言'],
  timezone: ['時區（IANA）', 'Time zone (IANA)', '时区（IANA）'],
  create: ['新增市場', 'Create market', '添加市场'],
  cancel: ['取消新增', 'Cancel creation', '取消添加'],
  created: ['市場已建立。請選擇銷售渠道並儲存設定。', 'Market created. Choose a sales channel and save the setup.', '市场已创建。请选择销售渠道并保存设置。'],
  none: ['沒有可用的同品牌、同幣別市場。', 'No eligible market matches this brand and currency.', '没有可用的同品牌、同币别市场。'],
  singleMarket: ['這個平台的店鋪只支援一個市場。', 'This platform supports one market per store.', '这个平台的店铺只支持一个市场。'],
  protected: ['此市場和渠道已有其他定價設定。請選擇其他渠道，或略過市場設定。', 'This market and channel already use a different price source. Choose another channel or skip market setup.', '此市场和渠道已有其他定价设置。请选择其他渠道，或略过市场设置。'],
  unscoped: ['未指定市場和渠道的匯入資料也可能套用至店鋪其他已啟用的渠道。', 'Import rows with no market or channel can also apply to this store’s other enabled channels.', '未指定市场和渠道的导入数据也可能套用至店铺其他已激活的渠道。'],
  save: ['儲存店鋪基礎價設定', 'Save store base price setup', '保存店铺基础价设置'],
  use: ['使用現有的店鋪基礎價設定', 'Use existing store base price setup', '使用现有的店铺基础价设置'],
  saving: ['儲存中…', 'Saving…', '保存中…'],
  skip: ['略過市場設定並繼續匯入', 'Skip market setup and continue importing', '略过市场设置并继续导入'],
  skipHint: ['可以略過市場設定。沒有相符的店鋪市場時，匯入仍會保留商品和 SKU，價格及庫存則不會寫入。', 'Market setup is optional. With no matching store market, the import keeps products and SKUs and leaves price and stock unrecorded.', '可以略过市场设置。没有相符的店铺市场时，导入仍会保留商品和 SKU，价格及库存则不会写入。'],
} as const;

interface Market {
  id: string;
  name: string;
  brand_id: string;
  currency: string;
  status: string;
}

interface StoreMarket {
  market_id: string;
  channel: string;
  price_source: string;
  enabled: boolean;
}

export type StoreMarketSetupResult = { status: 'configured'; marketId: string; channel: Channel } | { status: 'skipped' };

type SetupStore = Pick<Store, 'id' | 'brand_id' | 'provider' | 'status'> & {
  default_currency?: string;
  default_locale?: string;
};

type Props = { store: SetupStore; onReady: (result: StoreMarketSetupResult) => void };

const oneMarketProviders = new Set(['tiktok_shop', 'shopee', 'lazada']);
const existingConfig = (rows: StoreMarket[], marketId: string, channel: string) =>
  rows.find(row => row.market_id === marketId && row.channel === channel);

export function StoreMarketSetup({ store, onReady }: Props) {
  return <MarketSetup key={store.id} store={store} onReady={onReady} />;
}

function MarketSetup({ store, onReady }: Props) {
  const { l, lang } = useText();
  const currency = store.default_currency?.trim().toUpperCase() ?? '';
  const eligible = Boolean(store.brand_id && /^[A-Z]{3}$/.test(currency) && store.status !== 'disabled');
  const brandPath = `/brands/${encodeURIComponent(store.brand_id ?? '')}/markets`;
  const storePath = `/stores/${encodeURIComponent(store.id)}/markets`;
  const markets = useView<Market[]>(brandPath, {}, { enabled: eligible });
  const storeMarkets = useView<StoreMarket[]>(storePath, {}, { enabled: eligible });
  const action = useSetupWrite();
  const [marketId, setMarketId] = useState('');
  const [channel, setChannel] = useState<Channel | ''>('');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<Market>();
  const [checking, setChecking] = useState(false);
  const checkingRef = useRef(false);
  const busy = action.pending || checking;
  const singleMarket = oneMarketProviders.has(store.provider);
  const canUseMarket = (rows: StoreMarket[], id: string) => !singleMarket || rows.every(row => row.market_id === id);

  async function createMarket(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const field = (name: string) => String(form.get(name) ?? '').trim();
    if (!eligible || !field('name') || !field('primary_language') || !field('timezone')) return;
    const market = await action.run<Market>('POST', brandPath, {
      name: field('name'), country_code: field('country_code').toUpperCase(), primary_language: field('primary_language'),
      currency, timezone: field('timezone'),
    });
    if (!market) return;
    setCreated(market);
    setMarketId(market.id);
    setCreating(false);
  }

  async function save(event: FormEvent<HTMLFormElement>, market: Market | undefined) {
    event.preventDefault();
    if (!eligible || !market || !channel || busy || checkingRef.current) return;
    checkingRef.current = true;
    setChecking(true);
    try {
      const latest = await storeMarkets.refetch();
      const rows = latest.data?.data;
      if (latest.isError || !rows || !canUseMarket(rows, market.id)) return;
      const current = existingConfig(rows, market.id, channel);
      if (current && current.price_source !== 'store_base_price') return;
      if (!current?.enabled) {
        const saved = await action.run<StoreMarket[]>('PUT', storePath, {
          market_id: market.id, channel, price_source: 'store_base_price', enabled: true,
        });
        if (!saved) return;
      }
      onReady({ status: 'configured', marketId: market.id, channel });
    } finally {
      checkingRef.current = false;
      setChecking(false);
    }
  }

  function toggleCreation(value: boolean) {
    action.reset();
    setCreating(value);
  }

  return <div>
    <h3>{l(text.title)}</h3>
    <p>{l(text.intro)}</p>
    <p className="muted">{l(text.values)}</p>
    {eligible ? <Loaded read={markets}>{items => <Loaded read={storeMarkets}>{rows => {
      const all = created && !items.some(market => market.id === created.id) ? [...items, created] : items;
      const candidates = all.filter(market => market.brand_id === store.brand_id && market.currency === currency &&
        market.status === 'active' && canUseMarket(rows, market.id));
      const market = candidates.find(item => item.id === marketId);
      const current = market && channel ? existingConfig(rows, market.id, channel) : undefined;
      const protectedPrice = current && current.price_source !== 'store_base_price';
      const canCreate = !singleMarket || rows.length === 0;
      const unavailable = markets.isError || storeMarkets.isError || markets.isPlaceholderData || storeMarkets.isPlaceholderData;
      return <>
        {created?.id === marketId && <p className="muted" role="status">{l(text.created)}</p>}
        {creating && canCreate ? <form className="vs-form" onSubmit={createMarket} onChange={action.reset}>
          <fieldset disabled={busy || unavailable}>
            <div className="vs-field-row">
              <Field label={l(text.name)} required><input name="name" required maxLength={250} /></Field>
              <Field label={l(text.country)} required><input name="country_code" required pattern="[A-Za-z]{2}" maxLength={2} /></Field>
            </div>
            <div className="vs-field-row">
              <Field label={l(text.locale)} required><input name="primary_language" required maxLength={35} defaultValue={store.default_locale ?? (lang === 'en' ? 'en-US' : lang === 'zh-Hans' ? 'zh-CN' : 'zh-TW')} /></Field>
              <Field label={l(text.timezone)} required><input name="timezone" required defaultValue={Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC'} /></Field>
            </div>
            <div className="vs-actions"><button type="submit" className="vs-btn primary-soft">{l(busy ? text.saving : text.create)} · {currency}</button></div>
          </fieldset>
          <button type="button" className="vs-btn" disabled={busy} onClick={() => toggleCreation(false)}>{l(text.cancel)}</button>
        </form> : <form className="vs-form" onSubmit={event => void save(event, market)} onChange={action.reset}>
          <fieldset disabled={busy || unavailable}>
            <div className="vs-field-row">
              <Field label={l(text.market)} required><select required value={market?.id ?? ''} onChange={event => setMarketId(event.target.value)}>
                <option value="">—</option>{candidates.map(item => <option key={item.id} value={item.id}>{item.name} · {item.currency}</option>)}
              </select></Field>
              <Field label={l(text.channel)} required><select required value={channel} onChange={event => setChannel(event.target.value as Channel | '')}>
                <option value="">—</option>{Object.entries(channels).map(([id, name]) => <option key={id} value={id}>{l(name)}</option>)}
              </select></Field>
            </div>
            {!candidates.length && <p className="muted">{l(text.none)}</p>}
            {!canCreate && <p className="muted">{l(text.singleMarket)}</p>}
            {protectedPrice && <p className="vs-notice warning" role="status">{l(text.protected)}</p>}
            {market && channel && rows.some(row => row.enabled && row !== current) && <p className="muted">{l(text.unscoped)}</p>}
            <div className="vs-actions">
              <button type="submit" className="vs-btn primary-soft" disabled={!market || !channel || Boolean(protectedPrice)}>{l(busy ? text.saving : current?.enabled && !protectedPrice ? text.use : text.save)}</button>
              {canCreate && <button type="button" className="vs-btn" onClick={() => toggleCreation(true)}>{l(text.create)} · {currency}</button>}
            </div>
          </fieldset>
        </form>}
        {action.error !== undefined && <WriteProblem error={action.error} />}
      </>;
    }}</Loaded>}</Loaded> : <p className="vs-notice">{l(store.status === 'disabled' ? text.disabled : text.missing)}</p>}
    <p className="muted">{l(text.skipHint)}</p>
    <button type="button" className="vs-btn" disabled={busy} onClick={() => onReady({ status: 'skipped' })}>{l(text.skip)}</button>
  </div>;
}
