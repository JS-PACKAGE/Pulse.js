import type { HostSummary } from '../../src/shared/types.ts';
/** The alias when set, with the real hostname beside it so a renamed host stays identifiable. */
export function HostName({ host }: { host: Pick<HostSummary, 'alias' | 'hostname'> }) {
  if (host.alias === null) return <>{host.hostname}</>;
  return (
    <>
      {host.alias} <span className="hostname">{host.hostname}</span>
    </>
  );
}
