import i18next from 'i18next';
import fr from '../locales/fr.json';
import en from '../locales/en.json';
import type { Locale } from '../domain/model.js';
const instance = i18next.createInstance();
export const languagesReady = instance.init({
  resources: { fr: { translation: fr }, en: { translation: en } },
  fallbackLng: 'en',
  supportedLngs: ['fr', 'en'],
  interpolation: { escapeValue: false },
  initAsync: false,
});
export function locale(value: string): Locale {
  return value.startsWith('fr') ? 'fr' : 'en';
}
export function translator(
  language: Locale,
): (key: string, values?: Record<string, string | number>) => string {
  const fixed = instance.getFixedT(language);
  return (key, values = {}) => String(fixed(key, values));
}

export function proposalStatusKey(status: string): string {
  return status === 'expired' ? 'proposalExpired' : status;
}
