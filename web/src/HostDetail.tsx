import { useState } from 'react';
import type { Group, HostDetailResponse } from '../../src/shared/types.ts';
import { api, errorKey, number, osNames, percent, rate } from './api';
import { Chart } from './Chart';
import { Gauge } from './Gauge';
import { HostName } from './HostName';
import { useI18n } from './i18n';
import type { MessageKey } from './i18n';
import { UpdatesSummary } from './Updates';
const RANGES: [minutes: number, label: MessageKey][] = [
  [60, 'hour1'],
  [360, 'hour6'],
  [1440, 'day1'],
  [4320, 'day3'],
  [10080, 'day7'],
  [43200, 'month1'],
];
/** Decorative bar for a percentage already printed as text next to it. */
function Meter({ value }: { value: number | null }) {
  return (
    <div className="meter" aria-hidden="true">
      <span style={{ width: `${Math.min(Math.max(value ?? 0, 0), 100)}%` }} />
    </div>
  );
}
export function HostDetail({
  data,
  groups,
  minutes,
  loading,
  setMinutes,
  refresh,
}: {
  data: HostDetailResponse;
  groups: Group[];
  minutes: number;
  /** The charts still show the previous range while the selected one loads. */
  loading: boolean;
  setMinutes: (value: number) => void;
  refresh: () => void;
}) {
  const { t, lang } = useI18n();
  const { host, thresholds, series, gpuSeries, since, now } = data;
  const metrics = host.latest?.metrics;
  const date = (ts: number) => new Date(ts).toLocaleString(lang);
  const custom = groups.filter((group) => group.kind === 'custom' && host.customGroupIds.includes(group.id));
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<MessageKey | null>(null);
  const [editingAlias, setEditingAlias] = useState(false);
  const [alias, setAlias] = useState('');
  async function deleteHost() {
    const name = host.alias === null ? host.hostname : `${host.alias} (${host.hostname})`;
    if (!window.confirm(t('deleteHostConfirm', { name }))) return;
    setBusy(true);
    setActionError(null);
    try {
      await api<void>(`/api/hosts/${host.id}`, { method: 'DELETE' });
      window.location.hash = '#/hosts';
    } catch (failure) {
      setActionError(errorKey(failure));
      setBusy(false);
    }
  }
  async function saveAlias() {
    setBusy(true);
    setActionError(null);
    try {
      // An empty field removes the alias and the hostname is shown again.
      await api<void>(`/api/hosts/${host.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ alias: alias.trim() || null }),
      });
      setEditingAlias(false);
      refresh();
    } catch (failure) {
      setActionError(errorKey(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <a href="#/hosts">← {t('back')}</a>
      <div className="section-heading">
        {editingAlias ? (
          <form
            className="inline alias-form"
            onSubmit={(event) => {
              event.preventDefault();
              void saveAlias();
            }}
          >
            <input
              aria-label={t('alias')}
              placeholder={t('aliasHint')}
              maxLength={64}
              value={alias}
              onChange={(event) => setAlias(event.target.value)}
              disabled={busy}
              autoFocus
            />
            <button disabled={busy}>{t('save')}</button>
            <button type="button" disabled={busy} onClick={() => setEditingAlias(false)}>
              {t('cancel')}
            </button>
          </form>
        ) : (
          <h1>
            <HostName host={host} />
          </h1>
        )}
        <div className="inline">
          <span className={`badge ${host.status}`}>{t(host.status)}</span>
          {!editingAlias && (
            <button
              disabled={busy}
              onClick={() => {
                setAlias(host.alias ?? '');
                setEditingAlias(true);
              }}
            >
              {t('setAlias')}
            </button>
          )}
          <button className="danger" disabled={busy} onClick={() => void deleteHost()}>
            {t('deleteHost')}
          </button>
        </div>
      </div>
      {actionError && <p className="error">{t(actionError)}</p>}
      <section className="panel">
        <dl className="facts">
          <div>
            <dt>{t('hostname')}</dt>
            <dd>{host.hostname}</dd>
          </div>
          <div>
            <dt>{t('os')}</dt>
            <dd>
              {osNames[host.osFamily]} · {host.osVersion}
            </dd>
          </div>
          <div>
            <dt>{t('arch')}</dt>
            <dd>{host.arch}</dd>
          </div>
          <div>
            <dt>{t('cpuModel')}</dt>
            <dd>{host.cpuModel}</dd>
          </div>
          <div>
            <dt>{t('agentVersion')}</dt>
            <dd>{host.agentVersion}</dd>
          </div>
          <div>
            <dt>{t('updates')}</dt>
            <dd>
              <UpdatesSummary updates={host.updates} />
              {host.updates && (
                <>
                  <br />
                  <span className="muted">{t('updatesCheckedAt', { time: date(host.updates.checkedAt) })}</span>
                </>
              )}
            </dd>
          </div>
          <div>
            <dt>{t('firstSeen')}</dt>
            <dd>{date(host.firstSeen)}</dd>
          </div>
          <div>
            <dt>{t('lastSeen')}</dt>
            <dd>{date(host.lastSeen)}</dd>
          </div>
          <div>
            <dt>{t('status')}</dt>
            <dd>{t(host.status)}</dd>
          </div>
        </dl>
        <h3>{t('customGroups')}</h3>
        {custom.length ? (
          <div className="inline">
            {custom.map((group) => (
              <a className="tag" href="#/hosts" key={group.id}>
                {group.name}
              </a>
            ))}
          </div>
        ) : (
          <p className="muted">{t('noGroups')}</p>
        )}
      </section>
      <h2>{t('current')}</h2>
      <div className="card-grid metrics">
        <Gauge title={t('cpu')} value={metrics?.cpuLoadPercent ?? null} threshold={thresholds.cpuLoadPercent} />
        <Gauge
          title={t('memory')}
          value={percent(metrics?.memUsedMB, metrics?.memTotalMB)}
          threshold={thresholds.memUsedPercent}
        >
          <p>
            {number(metrics?.memUsedMB)} / {number(metrics?.memTotalMB)} MB
          </p>
        </Gauge>
        <Gauge
          title={t('disk')}
          value={percent(metrics?.diskUsedGB, metrics?.diskTotalGB)}
          threshold={thresholds.diskUsedPercent}
        >
          <p>
            {number(metrics?.diskUsedGB)} / {number(metrics?.diskTotalGB)} GB
          </p>
        </Gauge>
        <section className="panel network">
          <h3>{t('network')}</h3>
          <p>
            ↓ {t('receive')}: {rate(metrics?.netRxKbps)}
          </p>
          <p>
            ↑ {t('transmit')}: {rate(metrics?.netTxKbps)}
          </p>
        </section>
      </div>
      <section className="panel">
        <h3>{t('gpu')}</h3>
        {host.latest === null ? (
          <p>N/A</p>
        ) : host.latest.gpus.length === 0 ? (
          <p className="muted">{host.gpuCount > 0 ? 'N/A' : t('noGpu')}</p>
        ) : (
          <div className="card-grid">
            {host.latest.gpus.map((gpu) => (
              <div className="gpu-card" key={`${gpu.vendor}-${gpu.index}`}>
                <h4>
                  {gpu.name} #{gpu.index}
                </h4>
                <p>
                  {t('vendor')}: {gpu.vendor}
                </p>
                <p>
                  {t('utilization')}: {number(gpu.utilPercent, '%')}
                </p>
                <Meter value={gpu.utilPercent} />
                <p>
                  {t('memory')}: {number(gpu.memUsedMB)} / {number(gpu.memTotalMB)} MB (
                  {number(percent(gpu.memUsedMB, gpu.memTotalMB), '%')})
                </p>
                <Meter value={percent(gpu.memUsedMB, gpu.memTotalMB)} />
              </div>
            ))}
          </div>
        )}
      </section>
      <div className="section-heading">
        <h2>{t('history')}</h2>
        <div className="segmented" role="group" aria-label={t('range')}>
          {RANGES.map(([value, key]) => (
            <button key={value} type="button" aria-pressed={minutes === value} onClick={() => setMinutes(value)}>
              {t(key)}
            </button>
          ))}
        </div>
      </div>
      <div className={loading ? 'chart-grid loading' : 'chart-grid'} aria-busy={loading}>
        <Chart
          title={t('cpu')}
          since={since}
          now={now}
          threshold={thresholds.cpuLoadPercent}
          lines={[{ label: t('cpu'), points: series.map((point) => ({ ts: point.ts, value: point.cpuLoadPercent })) }]}
        />
        <Chart
          title={t('memory')}
          since={since}
          now={now}
          threshold={thresholds.memUsedPercent}
          lines={[
            {
              label: t('memory'),
              points: series.map((point) => ({ ts: point.ts, value: percent(point.memUsedMB, point.memTotalMB) })),
            },
          ]}
        />
        <Chart
          title={t('disk')}
          since={since}
          now={now}
          threshold={thresholds.diskUsedPercent}
          lines={[
            {
              label: t('disk'),
              points: series.map((point) => ({ ts: point.ts, value: percent(point.diskUsedGB, point.diskTotalGB) })),
            },
          ]}
        />
        <Chart
          title={t('network')}
          since={since}
          now={now}
          unit=" kbps"
          lines={[
            { label: `↓ ${t('receive')}`, points: series.map((point) => ({ ts: point.ts, value: point.netRxKbps })) },
            { label: `↑ ${t('transmit')}`, points: series.map((point) => ({ ts: point.ts, value: point.netTxKbps })) },
          ]}
        />
        <Chart
          title={`${t('network')} ↓`}
          since={since}
          now={now}
          unit=" kbps"
          threshold={thresholds.netRxKbps}
          lines={[{ label: t('receive'), points: series.map((point) => ({ ts: point.ts, value: point.netRxKbps })) }]}
        />
        <Chart
          title={`${t('network')} ↑`}
          since={since}
          now={now}
          unit=" kbps"
          threshold={thresholds.netTxKbps}
          lines={[{ label: t('transmit'), points: series.map((point) => ({ ts: point.ts, value: point.netTxKbps })) }]}
        />
        {gpuSeries.map((gpu) => (
          <Chart
            key={`${gpu.vendor}-${gpu.index}`}
            title={`${gpu.name} #${gpu.index} · ${t('utilization')}`}
            since={since}
            now={now}
            threshold={thresholds.gpuUtilPercent}
            lines={[
              {
                label: `${gpu.vendor} · ${gpu.name}`,
                points: gpu.points.map((point) => ({ ts: point.ts, value: point.utilPercent })),
              },
            ]}
          />
        ))}
      </div>
    </>
  );
}
