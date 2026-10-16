import { readFile } from 'node:fs/promises';

/** /etc/pulse-agent/agent.json, written by install.sh. */
export interface AgentConfig {
  serverUrl: URL;
  /**
   * Cloudflare Access service token, sent as `CF-Access-Client-Id` / `CF-Access-Client-Secret`;
   * checked only by Cloudflare Zero Trust. Never log the secret.
   */
  accessClientId: string;
  accessClientSecret: string;
  diskPath: string;
  /** Empty = interface of the default route. */
  netInterface: string;
}

const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];

export function parseAgentConfig(raw: unknown): AgentConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('agent config must be a JSON object');
  const doc = raw as Record<string, unknown>; // object-ness checked above; each field is checked below

  if (typeof doc.serverUrl !== 'string') throw new Error('agent config: serverUrl is required');
  let serverUrl: URL;
  try {
    serverUrl = new URL(doc.serverUrl);
  } catch {
    throw new Error('agent config: serverUrl is not a valid URL');
  }
  // Plain HTTP only for local development (AGENTS.md security rule 1).
  const local = LOOPBACK.includes(serverUrl.hostname) || serverUrl.hostname.startsWith('127.');
  if (serverUrl.protocol !== 'https:' && !(serverUrl.protocol === 'http:' && local)) {
    throw new Error('agent config: serverUrl must use https:// (http:// is only allowed for loopback hosts)');
  }
  if (serverUrl.search || serverUrl.username || serverUrl.password) {
    throw new Error('agent config: serverUrl must not carry credentials or a query string');
  }

  const accessClientId = headerValue(doc.accessClientId, 'accessClientId');
  const accessClientSecret = headerValue(doc.accessClientSecret, 'accessClientSecret');

  const diskPath = doc.diskPath ?? '/';
  const netInterface = doc.netInterface ?? '';
  if (typeof diskPath !== 'string' || !diskPath.startsWith('/')) throw new Error('agent config: diskPath must be an absolute path');
  if (typeof netInterface !== 'string' || !/^[\w.:-]*$/.test(netInterface)) {
    throw new Error('agent config: netInterface must be an interface name or ""');
  }
  return { serverUrl, accessClientId, accessClientSecret, diskPath, netInterface };
}

function headerValue(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`agent config: ${field} is required`);
  if (/[\r\n]/.test(value)) throw new Error(`agent config: ${field} must be a single line`);
  return value.trim();
}

export async function loadAgentConfig(path: string): Promise<AgentConfig> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    throw new Error(`cannot read agent config ${path}: ${(err as NodeJS.ErrnoException).code ?? 'error'}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // Do not echo the parser message: it may quote file content, i.e. the client secret.
    throw new Error(`agent config ${path} is not valid JSON`);
  }
  return parseAgentConfig(raw);
}
