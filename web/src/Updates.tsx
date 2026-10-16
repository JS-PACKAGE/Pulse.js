import type { OsUpdates } from '../../src/shared/types.ts';
import { useI18n } from './i18n';
/** Pending OS updates of one host; security updates are called out. */
export function UpdatesSummary({ updates }: { updates: OsUpdates | null }) {
  const { t } = useI18n();
  if (!updates) return <span className="muted">{t('updatesUnknown')}</span>;
  if (updates.pending === 0) return <span>{t('updatesNone')}</span>;
  return (
    <span className="warn">
      {t('updatesPending', { count: updates.pending })}
      {updates.security ? (
        <strong className="crit"> · {t('updatesSecurity', { count: updates.security })}</strong>
      ) : null}
    </span>
  );
}
