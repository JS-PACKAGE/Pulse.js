import { useEffect, useState } from 'react';
import { HOST_STATUSES } from '../../src/shared/types.ts';
import type { HostSummary } from '../../src/shared/types.ts';
import { duration, number, osNames, rate } from './api';
import { Groups } from './Groups';
import { HostDetail } from './HostDetail';
import { readPreference, savePreference, useI18n } from './i18n';
import type { Language } from './i18n';
import { UpdatesSummary } from './Updates';
import { useLiveData } from './useLiveData';
function Overview({ hosts }: { hosts: HostSummary[] }) {
  const { t, lang } = useI18n();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const abnormal = hosts.filter((host) => host.status === 'alert' || host.status === 'offline');
  const withUpdates = hosts.filter((host) => (host.updates?.pending ?? 0) > 0);
  return (
    <>
      <h1>{t('overview')}</h1>
      {hosts.length > 0 && (
        <div className="stats">
          {HOST_STATUSES.map((status) => (
            <div className={`panel stat ${status}`} key={status}>
              <span className="stat-value">{hosts.filter((host) => host.status === status).length}</span>
              <span className="stat-label">{t(status)}</span>
            </div>
          ))}
        </div>
      )}
      {hosts.length === 0 ? (
        <div className="panel empty">
          <h2>{t('noHosts')}</h2>
        </div>
      ) : abnormal.length === 0 ? (
        <div className="panel empty healthy">
          <div className="radar" aria-hidden="true" />
          <h2>{t('healthy')}</h2>
          <p>{t('healthyHint')}</p>
        </div>
      ) : (
        <div className="card-grid">
          {abnormal.map((host) => (
            <a className={`panel host-card ${host.status}`} href={`#/hosts/${host.id}`} key={host.id}>
              <div className="section-heading">
                <h2>{host.hostname}</h2>
                <span className={`badge ${host.status}`}>{t(host.status)}</span>
              </div>
              <p>
                <span className="tag">{osNames[host.osFamily]}</span> {host.osVersion}
              </p>
              {host.status === 'offline' ? (
                <p>
                  {t('offline')} · {t('lastSeen')}: {new Date(host.lastSeen).toLocaleString(lang)}
                </p>
              ) : (
                <ul className="alerts">
                  {host.alerts.map((item, index) => (
                    <li key={index} className={item.level}>
                      <strong>
                        {t(item.level)} · {t(item.metric)}
                      </strong>
                      {item.gpu && (
                        <span>
                          {item.gpu.name} #{item.gpu.index} · {item.gpu.vendor}
                        </span>
                      )}
                      <span>
                        {item.metric === 'netRxKbps' || item.metric === 'netTxKbps'
                          ? rate(item.value)
                          : number(item.value, '%')}{' '}
                        · {t('threshold')}:{' '}
                        {item.metric === 'netRxKbps' || item.metric === 'netTxKbps'
                          ? rate(item.threshold)
                          : number(item.threshold, '%')}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="muted">{t('duration', { time: duration(now - host.statusSince) })}</p>
            </a>
          ))}
        </div>
      )}
      {withUpdates.length > 0 && (
        <section className="panel">
          <h2>{t('updatesReminder', { count: withUpdates.length })}</h2>
          <ul className="alerts">
            {withUpdates.map((host) => (
              <li key={host.id} className={host.updates?.security ? 'crit' : 'warn'}>
                <a href={`#/hosts/${host.id}`}>{host.hostname}</a>
                <UpdatesSummary updates={host.updates} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
export function App() {
  const { t, lang, setLang } = useI18n();
  const [hash, setHash] = useState(() => window.location.hash || '#/');
  const [minutes, setMinutes] = useState(60);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const saved = readPreference('pulse.theme');
    return saved === 'dark' || saved === 'light'
      ? saved
      : window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    savePreference('pulse.theme', theme);
  }, [theme]);
  useEffect(() => {
    const update = () => setHash(window.location.hash || '#/');
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  const match = /^#\/hosts\/([1-9]\d*)$/.exec(hash);
  const parsedId = match?.[1] ? Number(match[1]) : null;
  const hostId = parsedId !== null && Number.isSafeInteger(parsedId) ? parsedId : null;
  const overview = hash === '#/' || hash === '#';
  const hostList = hash === '#/hosts';
  const valid = overview || hostList || hostId !== null;
  const { data, error, connection, refresh } = useLiveData(hostId, minutes);
  return (
    <>
      <header className="topbar">
        <a className="brand" href="#/">
          <svg viewBox="0 0 32 32" aria-hidden="true">
            <rect className="logo-frame" x="1.5" y="1.5" width="29" height="29" rx="6" />
            <path className="logo-ecg" pathLength="100" d="M4.5 17H10l2.5-6.5 4.5 13 3.5-9.5 1.5 3h5.5" />
          </svg>
          <span className="brand-name">
            Pulse<span>.js</span>
          </span>
        </a>
        <nav aria-label="Pulse.js">
          <a href="#/" aria-current={overview ? 'page' : undefined}>
            {t('overview')}
          </a>
          <a href="#/hosts" aria-current={hostList || hostId !== null ? 'page' : undefined}>
            {t('hosts')}
          </a>
        </nav>
        <div className="toolbar">
          <span className={`connection ${connection}`} role="status">
            <i />
            {t(connection)}
          </span>
          <label>
            <span className="sr-only">{t('language')}</span>
            <select value={lang} onChange={(event) => setLang(event.target.value as Language)}>
              <option value="zh-TW">繁體中文</option>
              <option value="en">English</option>
              <option value="ja">日本語</option>
            </select>
          </label>
          <button
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            aria-label={`${t('theme')}: ${t(theme === 'dark' ? 'light' : 'dark')}`}
          >
            {t(theme === 'dark' ? 'light' : 'dark')}
          </button>
        </div>
      </header>
      <main>
        {!valid ? (
          <h1>{t('invalidRoute')}</h1>
        ) : (
          <>
            {error && (
              <div className="error panel" role="alert">
                {t(error)} {data && t('stale')} <button onClick={refresh}>{t('retry')}</button>
              </div>
            )}
            {!data && !error && (
              <p role="status" className="boot">
                {t('loading')}
              </p>
            )}
            {data &&
              (hostId !== null && data.detail ? (
                <HostDetail
                  data={data.detail}
                  groups={data.groups.groups}
                  minutes={minutes}
                  loading={data.minutes !== minutes}
                  setMinutes={setMinutes}
                />
              ) : data.hosts ? (
                hostList ? (
                  <Groups groups={data.groups.groups} hosts={data.hosts.hosts} refresh={refresh} />
                ) : (
                  <Overview hosts={data.hosts.hosts} />
                )
              ) : null)}
          </>
        )}
      </main>
    </>
  );
}
