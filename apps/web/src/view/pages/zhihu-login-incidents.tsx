import { useView } from '../data/use-view';
import { Loaded, Section, useText } from '../parts';

type LoginIncident = { id: string; device_id: string; reported_at: string };

export function ZhihuLoginIncidents() {
  const { l } = useText();
  const read = useView<LoginIncident[]>('/zhihu-stats/incidents');
  return <Section title={l(['知乎 Worker 異常', 'Zhihu Worker incidents'])}>
    <Loaded read={read}>{items => Array.isArray(items) && items.length ? <ul className="vs-list" aria-label={l(['知乎登入異常', 'Zhihu sign-in incidents'])}>
      {items.map(item => <li key={item.id}>
        <div className="vs-grow">
          <strong className="vs-notice warning">{l(['需要使用者登入知乎', 'Zhihu sign-in required'])}</strong>
          <dl>
            <dt>{l(['任務 ID', 'Task ID'])}</dt><dd><code>{item.id}</code></dd>
            <dt>{l(['裝置 ID', 'Device ID'])}</dt><dd><code>{item.device_id}</code></dd>
            <dt>{l(['記錄時間（UTC）', 'Recorded at (UTC)'])}</dt><dd><time dateTime={item.reported_at}>{item.reported_at}</time></dd>
          </dl>
        </div>
      </li>)}
    </ul> : <p className="muted">{l(['目前沒有知乎登入異常。', 'No Zhihu sign-in incidents.'])}</p>}</Loaded>
  </Section>;
}
