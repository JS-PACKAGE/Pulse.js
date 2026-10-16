import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { zhTW } from './zh-TW';
import type { MessageKey } from './zh-TW';
import { en } from './en';
import { ja } from './ja';
export type { MessageKey } from './zh-TW';
export type Language = 'zh-TW' | 'en' | 'ja';
const dictionaries = { 'zh-TW': zhTW, en, ja };
export function readPreference(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function savePreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Storage can be disabled by browser policy. */
  }
}
function initialLanguage(): Language {
  const saved = readPreference('pulse.lang');
  if (saved === 'zh-TW' || saved === 'en' || saved === 'ja') return saved;
  const language = navigator.language.toLowerCase();
  return language.startsWith('zh') ? 'zh-TW' : language.startsWith('ja') ? 'ja' : 'en';
}
type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;
const Context = createContext<{ lang: Language; setLang: (lang: Language) => void; t: Translate } | null>(null);
export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Language>(initialLanguage);
  useEffect(() => {
    document.documentElement.lang = lang;
    savePreference('pulse.lang', lang);
  }, [lang]);
  const t: Translate = (key, params) =>
    dictionaries[lang][key].replace(/\{(\w+)\}/g, (match: string, name: string) => String(params?.[name] ?? match));
  return <Context.Provider value={{ lang, setLang, t }}>{children}</Context.Provider>;
}
export function useI18n() {
  const value = useContext(Context);
  if (!value) throw new Error('I18nProvider is required');
  return value;
}
