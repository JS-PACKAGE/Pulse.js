// Replaced at bundle time by scripts/build.mjs (esbuild `define`); tests run unbundled.
declare const __PULSE_VERSION__: string | undefined;

export const PULSE_VERSION: string = typeof __PULSE_VERSION__ === 'string' ? __PULSE_VERSION__ : '0.0.0-dev';
