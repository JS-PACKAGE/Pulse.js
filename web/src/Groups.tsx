import { useState } from 'react';
import type { Group, HostSummary } from '../../src/shared/types.ts';
import { api, errorKey, number, osNames, percent, rate } from './api';
import { useI18n } from './i18n';
import { UpdatesSummary } from './Updates';
import type { MessageKey } from './i18n';
export function HostTable({
  hosts,
  remove,
  busy = false,
}: {
  hosts: HostSummary[];
  remove?: (id: number) => void;
  busy?: boolean;
}) {
  const { t } = useI18n();
  if (hosts.length === 0) return <p className="muted">{t('noMembers')}</p>;
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>{t('status')}</th>
            <th>{t('hostname')}</th>
            <th>CPU %</th>
            <th>{t('memory')} %</th>
            <th>{t('disk')} %</th>
            <th>{t('network')} ↓↑</th>
            <th>GPU</th>
            <th>{t('updates')}</th>
            {remove && <th />}
          </tr>
        </thead>
        <tbody>
          {hosts.map((host) => {
            const metrics = host.latest?.metrics;
            return (
              <tr key={host.id}>
                <td>
                  <span className={`badge ${host.status}`}>{t(host.status)}</span>
                </td>
                <td>
                  <a href={`#/hosts/${host.id}`}>{host.hostname}</a>
                </td>
                <td>{number(metrics?.cpuLoadPercent, '%')}</td>
                <td>{number(percent(metrics?.memUsedMB, metrics?.memTotalMB), '%')}</td>
                <td>{number(percent(metrics?.diskUsedGB, metrics?.diskTotalGB), '%')}</td>
                <td>
                  ↓ {rate(metrics?.netRxKbps)}
                  <br />↑ {rate(metrics?.netTxKbps)}
                </td>
                <td>{host.gpuCount}</td>
                <td>
                  <UpdatesSummary updates={host.updates} />
                </td>
                {remove && (
                  <td>
                    <button disabled={busy} onClick={() => remove(host.id)}>
                      {t('remove')}
                    </button>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
function GroupPanel({ group, hosts, refresh }: { group: Group; hosts: HostSummary[]; refresh: () => void }) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(group.name);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const custom = group.kind === 'custom';
  const members = hosts.filter((host) => group.hostIds.includes(host.id));
  const available = hosts.filter((host) => !group.hostIds.includes(host.id));
  async function mutate(path: string, method: string, body?: object) {
    setBusy(true);
    setError(null);
    try {
      await api<void>(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
      setEditing(false);
      setSelected('');
      refresh();
    } catch (failure) {
      setError(errorKey(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="panel group">
      <header className="section-heading">
        {editing ? (
          <form
            className="inline"
            onSubmit={(event) => {
              event.preventDefault();
              void mutate(`/api/groups/${group.id}`, 'PATCH', { name });
            }}
          >
            <input
              aria-label={t('groupName')}
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={busy}
            />
            <button disabled={busy}>{t('save')}</button>
            <button type="button" disabled={busy} onClick={() => setEditing(false)}>
              {t('cancel')}
            </button>
          </form>
        ) : (
          <h3>
            {group.osFamily ? osNames[group.osFamily] : group.name}{' '}
            <span className="muted">{t('count', { count: members.length })}</span>
          </h3>
        )}
        {custom && !editing && (
          <div className="inline">
            <button
              disabled={busy}
              onClick={() => {
                setName(group.name);
                setEditing(true);
              }}
            >
              {t('rename')}
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={() => {
                if (window.confirm(t('deleteConfirm', { name: group.name })))
                  void mutate(`/api/groups/${group.id}`, 'DELETE');
              }}
            >
              {t('delete')}
            </button>
          </div>
        )}
      </header>
      {error && (
        <p role="alert" className="error">
          {t(error)}
        </p>
      )}
      <HostTable
        hosts={members}
        busy={busy}
        {...(custom
          ? {
              remove: (id: number) => {
                void mutate(`/api/groups/${group.id}/hosts/${id}`, 'DELETE');
              },
            }
          : {})}
      />
      {custom && (
        <form
          className="inline assign"
          onSubmit={(event) => {
            event.preventDefault();
            if (available.some((host) => String(host.id) === selected))
              void mutate(`/api/groups/${group.id}/hosts/${selected}`, 'PUT');
          }}
        >
          <select
            aria-label={t('selectHost')}
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
            disabled={busy || available.length === 0}
          >
            <option value="">{t('selectHost')}</option>
            {available.map((host) => (
              <option key={host.id} value={host.id}>
                {host.hostname}
              </option>
            ))}
          </select>
          <button disabled={busy || !available.some((host) => String(host.id) === selected)}>{t('assign')}</button>
        </form>
      )}
    </article>
  );
}
export function Groups({ groups, hosts, refresh }: { groups: Group[]; hosts: HostSummary[]; refresh: () => void }) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  async function create() {
    setBusy(true);
    setError(null);
    try {
      await api<Group>('/api/groups', { method: 'POST', body: JSON.stringify({ name }) });
      setName('');
      refresh();
    } catch (failure) {
      setError(errorKey(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <h1>{t('hosts')}</h1>
      <h2>{t('systemGroups')}</h2>
      {groups
        .filter((group) => group.kind === 'system')
        .map((group) => (
          <GroupPanel key={group.id} group={group} hosts={hosts} refresh={refresh} />
        ))}
      <h2>{t('customGroups')}</h2>
      <form
        className="inline panel"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <input
          aria-label={t('groupName')}
          placeholder={t('groupName')}
          value={name}
          required
          onChange={(event) => setName(event.target.value)}
          disabled={busy}
        />
        <button disabled={busy || !name.trim()}>{t('create')}</button>
      </form>
      {error && (
        <p role="alert" className="error">
          {t(error)}
        </p>
      )}
      {!groups.some((group) => group.kind === 'custom') && <p className="muted">{t('noGroups')}</p>}
      {groups
        .filter((group) => group.kind === 'custom')
        .map((group) => (
          <GroupPanel key={group.id} group={group} hosts={hosts} refresh={refresh} />
        ))}
    </>
  );
}
