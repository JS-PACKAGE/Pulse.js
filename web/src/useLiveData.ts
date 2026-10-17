import { useCallback, useEffect, useState } from 'react';
import type { HostDetailResponse, ListGroupsResponse, ListHostsResponse } from '../../src/shared/types.ts';
import { api, errorKey } from './api';
import type { MessageKey } from './i18n';
export interface PageData {
  hosts?: ListHostsResponse;
  detail?: HostDetailResponse;
  /** Range the detail series was fetched for; differs from the requested one while a new range loads. */
  minutes?: number;
  groups: ListGroupsResponse;
}
export function useLiveData(hostId: number | null, minutes: number) {
  const [data, setData] = useState<PageData | null>(null);
  const [error, setError] = useState<MessageKey | null>(null);
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'reconnecting'>('connecting');
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  // Only a different page starts blank; a new time range keeps the current page (and its charts)
  // on screen until the new series arrives.
  useEffect(() => {
    setData(null);
  }, [hostId]);
  useEffect(() => {
    const current = new AbortController();
    const options = { signal: current.signal };
    async function load() {
      try {
        const [groups, page] = await Promise.all([
          api<ListGroupsResponse>('/api/groups', options),
          hostId === null
            ? api<ListHostsResponse>('/api/hosts', options)
            : api<HostDetailResponse>(`/api/hosts/${hostId}?minutes=${minutes}`, options),
        ]);
        if (current.signal.aborted) return;
        setData(
          hostId === null
            ? { groups, hosts: page as ListHostsResponse }
            : { groups, detail: page as HostDetailResponse, minutes },
        );
        setError(null);
      } catch (failure) {
        if (!current.signal.aborted) setError(errorKey(failure));
      }
    }
    void load();
    return () => current.abort();
  }, [hostId, minutes, revision]);
  useEffect(() => {
    const source = new EventSource('/api/events');
    let debounce: number | undefined;
    source.onopen = () => setConnection('connected');
    source.onerror = () => setConnection('reconnecting');
    source.onmessage = () => {
      if (debounce !== undefined) return;
      debounce = window.setTimeout(() => {
        debounce = undefined;
        refresh();
      }, 500);
    };
    const fallback = setInterval(refresh, 30_000);
    return () => {
      source.close();
      clearTimeout(debounce);
      clearInterval(fallback);
    };
  }, [refresh]);
  return { data, error, connection, refresh };
}
