export { t, type MessageKey } from './t';
export { useT, useLocale } from './useT';
export {
  getLocale,
  getLanguageSetting,
  resolveLocale,
  setLanguageSetting,
  subscribeLocale,
  initLocale,
  type Locale,
  type LanguageSetting,
} from './store';
export {
  resolveScanErrorMessage,
  resolveAddPatternErrorMessage,
  resolveResetAllDataErrorMessage,
  resolveStartupDirectoryError,
} from './errors';
