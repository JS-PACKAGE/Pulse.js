import { execFile } from 'node:child_process';

/** The external tool is not installed (ENOENT). Callers decide whether that means "no data". */
export class CommandMissingError extends Error {
  constructor(readonly command: string) {
    super(`${command} not found`);
  }
}

export interface RunOptions {
  /** Overrides the default timeout for slow tools (e.g. `softwareupdate -l` queries Apple). */
  timeoutMs?: number;
  /** Non-zero exit codes that still mean success, e.g. `dnf check-update` exits 100 when updates exist. */
  okExitCodes?: readonly number[];
}

/** Runs a system tool; any other failure (timeout, non-zero exit) throws (fail-closed). */
export type RunCommand = (command: string, args: readonly string[], options?: RunOptions) => Promise<string>;

export function createRunCommand(defaultTimeoutMs = 10_000): RunCommand {
  return (command, args, options) => {
    const timeoutMs = options?.timeoutMs ?? defaultTimeoutMs;
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => {
      if (!err) return resolve(stdout);
      if ('code' in err && err.code === 'ENOENT') return reject(new CommandMissingError(command));
      if (!err.killed && typeof err.code === 'number' && options?.okExitCodes?.includes(err.code)) return resolve(stdout);
      reject(new Error(`${command} failed: ${err.killed ? `timed out after ${timeoutMs} ms` : err.message}`));
    });
    return promise;
  };
}
