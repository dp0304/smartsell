import { useSearchParams } from 'react-router-dom';
import type { ChannelReadiness, ChannelSummary, MachineSummary } from '../data/hub-types';
import { useView, useViewContext } from '../data/use-view';
import { Loaded, PageHeader, RouterLink, useText } from '../parts';
import { approvalModeText, hub } from '../hub-copy';
import { Badge, ChannelName, Empty, LoginBadge, ModeBadge, OnlineBadge, ZoneNote, browserZone, isoLocal, localLabel, providerName, todayIn, tr } from '../hub-parts';

export const READINESS_KEYS: (keyof ChannelReadiness)[] = ['logged_in', 'automation_notice', 'defaults_ready', 'approval_mode_chosen', 'risk_ack_or_assist', 'dry_run_passed'];
export const readinessDone = (readiness: ChannelReadiness) => READINESS_KEYS.filter(key => readiness[key]).length;

/** /app/:ws/channels — every posting account with its machine, login, mode, approval, limits and readiness (§9.4). */
export function ChannelsPage() {
  const { l, lang } = useText();
  const { base } = useViewContext();
  const [params, setParams] = useSearchParams();
  const provider = params.get('provider') ?? '';
  const machine = params.get('machine_id') ?? '';
  const read = useView<ChannelSummary[]>('/views/channels', { provider, machine_id: machine });
  const machines = useView<MachineSummary[]>('/views/machines');
  const today = todayIn();
  const set = (key: string, value: string) => { const next = new URLSearchParams(params); if (value) next.set(key, value); else next.delete(key); setParams(next, { replace: true }); };
  return <>
    <PageHeader title={l(hub.channels.title)} subtitle={l(hub.channels.subtitle)} asOf={read.asOf}>
      <ZoneNote zone={browserZone()} />
      <label className="vs-select"><span>{l(hub.channels.filterProvider)}</span><select value={provider} onChange={event => set('provider', event.target.value)}>
        <option value="">{l(hub.channels.allProviders)}</option>{['x', 'tiktok'].map(value => <option key={value} value={value}>{providerName(l, value)}</option>)}</select></label>
      <label className="vs-select"><span>{l(hub.channels.filterMachine)}</span><select value={machine} onChange={event => set('machine_id', event.target.value)}>
        <option value="">{l(hub.channels.allMachines)}</option>{(machines.value ?? []).map(item => <option key={item.machine_id} value={item.machine_id}>{item.name}</option>)}</select></label>
    </PageHeader>
    <Loaded read={read}>{channels => channels.length ? <div className="hub-card-grid">{channels.map(channel => {
      const done = readinessDone(channel.readiness);
      return <article key={channel.channel_id} className="hub-card">
        <header><h2><RouterLink to={`${base}/channels/${encodeURIComponent(channel.channel_id)}`}><ChannelName provider={channel.provider} handle={channel.handle} label={channel.display_name} /></RouterLink></h2>
          <Badge tone={done === READINESS_KEYS.length ? 'good' : channel.can_schedule ? 'warning' : 'critical'}>{l(hub.channels.readiness)} {done}/{READINESS_KEYS.length}</Badge></header>
        <dl className="hub-facts tight">
          <div><dt>{l(hub.common.machine)}</dt><dd>{channel.machine ? <><RouterLink to={`${base}/machines/${encodeURIComponent(channel.machine.id)}`}>{channel.machine.name}</RouterLink> <OnlineBadge online={channel.machine.online} /></> : l(hub.channels.noMachine)}</dd></div>
          <div><dt>{l(hub.channels.login)}</dt><dd><LoginBadge state={channel.login.state} /></dd></div>
          <div><dt>{l(hub.channels.mode)}</dt><dd><ModeBadge mode={channel.effective_mode} /></dd></div>
          <div><dt>{l(hub.channels.approval)}</dt><dd>{tr(l, approvalModeText, channel.approval_mode)}</dd></div>
          <div><dt>{l(hub.channels.today)}</dt><dd>{channel.scheduled_today + channel.published_today} / {channel.daily_cap}</dd></div>
          <div><dt>{l(hub.channels.next)}</dt><dd>{channel.next_post ? <RouterLink to={`${base}/posts/${encodeURIComponent(channel.next_post.post_id)}`}>{localLabel(isoLocal(channel.next_post.scheduled_at) ?? channel.next_post.local_time, today, lang)}</RouterLink> : '—'}</dd></div>
        </dl>
        {channel.pause && <p className="hub-alert-text">{l(hub.channels.pause)} · {channel.pause.reason}</p>}
        {channel.blockers.length > 0 && <ul className="hub-warnings">{channel.blockers.map(blocker => <li key={blocker.code}>{blocker.message}</li>)}</ul>}
      </article>;
    })}</div> : <section className="vs-card"><Empty>{l(hub.channels.empty)}</Empty></section>}</Loaded>
  </>;
}
