import { en } from './locales/en.js';
import { zhCN } from './locales/zh-CN.js';

const LS_KEY_LOCALE = 'kimi-memory-vis.locale';
const DEFAULT_LOCALE = 'en';
const SUPPORTED_LOCALES = [DEFAULT_LOCALE, 'zh-CN'];

const dictionaries = {
  en,
  'zh-CN': zhCN,
};

let currentLocale = null;
const listeners = new Set();

function detectLocale() {
  let stored = null;
  try {
    stored = localStorage.getItem(LS_KEY_LOCALE);
  } catch {
    stored = null;
  }
  if (stored && SUPPORTED_LOCALES.includes(stored)) return stored;
  const navLanguage = typeof navigator !== 'undefined' ? navigator.language : '';
  return navLanguage && navLanguage.toLowerCase().startsWith('zh') ? 'zh-CN' : DEFAULT_LOCALE;
}

export function translate(locale, key, params) {
  const dict = dictionaries[locale] || dictionaries[DEFAULT_LOCALE];
  let template = dict[key];
  if (template === undefined) {
    template = dictionaries[DEFAULT_LOCALE][key];
    if (template === undefined) {
      console.warn(`i18n: missing translation key "${key}"`);
      return key;
    }
    console.warn(`i18n: key "${key}" missing for locale "${locale}", falling back to English`);
  }
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

export function t(key, params) {
  return translate(getLocale(), key, params);
}

export function getLocale() {
  if (!currentLocale) currentLocale = detectLocale();
  return currentLocale;
}

export function setLocale(locale) {
  if (!SUPPORTED_LOCALES.includes(locale) || locale === currentLocale) return;
  currentLocale = locale;
  try {
    localStorage.setItem(LS_KEY_LOCALE, locale);
  } catch {
    // Storage unavailable (private mode etc.); keep the in-memory switch.
  }
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale;
  }
  listeners.forEach((cb) => cb(locale));
}

export function onLocaleChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

if (typeof document !== 'undefined') {
  document.documentElement.lang = getLocale();
}
