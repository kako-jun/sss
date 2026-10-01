import type { Locale } from './i18n';

// #114: 撮影日（EXIF の日時）をロケールに応じて読みやすく整形する。
//
// 入力は EXIF 由来の文字列で、区切りがいくつかある:
//   "2023:08:15 12:34:56"（EXIF 仕様のワイヤ形式）
//   "2023-08-15 12:34:56"（バックエンドの kamadak-exif `display_value()` の出力）
//   "2023-08-15T12:34:56"（ISO 8601）
//   "2023-08-15"（日付のみ）
//   "2023-08-15T12:34:56Z" / "...+09:00"（タイムゾーン付き）
//
// 方針:
// - **壁時計の値をそのまま使う**。EXIF の日時は通常カメラのローカル時刻でタイムゾーンを
//   持たないので、`new Date(raw)` の解釈（日付のみは UTC、時刻付きはローカル）や表示側の
//   タイムゾーン変換を一切通さず、年月日時分を自前で取り出して整形する。Z / +09:00 が付いて
//   いても換算せず、書かれた日時のまま出す（「撮った場所の時刻」を見せたい。換算すると
//   表示する環境の TZ で日付がずれる）。整形は `timeZone: 'UTC'` 固定の Intl に UTC で組んだ
//   日時を渡すので、実行環境の TZ に依存しない。
// - 時刻が無い、または 00:00:00（日付だけが入っていて時刻が不明なことが多い）なら時刻は出さない。
// - 解釈できない値・存在しない日付（2023-02-30 等）・空は空文字を返す（呼び出し側は何も出さない）。
//   カメラが入れる "0000:00:00 00:00:00" のようなプレースホルダを生のまま見せないため。

const PATTERN =
  /^\s*"?(\d{4})[:\-/](\d{2})[:\-/](\d{2})(?:[T ]+(\d{2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?\s*(?:Z|[+-]\d{2}(?::?\d{2})?)?)?"?\s*$/i;

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  hasTime: boolean;
}

/** 文字列を壁時計の各要素へ分解する。解釈できない・暦として存在しない値は null。 */
export function parseCapturedDate(raw: string | null | undefined): Parts | null {
  if (!raw) return null;
  const m = PATTERN.exec(raw);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hasTime = m[4] !== undefined;
  const hour = hasTime ? Number(m[4]) : 0;
  const minute = hasTime ? Number(m[5]) : 0;
  const second = hasTime && m[6] !== undefined ? Number(m[6]) : 0;
  if (year < 1 || month < 1 || month > 12 || day < 1) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const check = new Date(0);
  check.setUTCFullYear(year, month - 1, day);
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return { year, month, day, hour, minute, second, hasTime };
}

const NARROW_SPACES = new RegExp('[\\u202f\\u00a0]', 'g');

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(locale: Locale, withTime: boolean): Intl.DateTimeFormat {
  const key = `${locale}:${withTime}`;
  let f = formatterCache.get(key);
  if (!f) {
    const date: Intl.DateTimeFormatOptions = {
      timeZone: 'UTC',
      year: 'numeric',
      month: locale === 'ja' ? 'long' : 'short',
      day: 'numeric',
    };
    const time: Intl.DateTimeFormatOptions = withTime
      ? locale === 'ja'
        ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
        : { hour: 'numeric', minute: '2-digit', hour12: true }
      : {};
    f = new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', { ...date, ...time });
    formatterCache.set(key, f);
  }
  return f;
}

/**
 * 撮影日をロケール整形する（ja「2023年8月15日 12:34」/ en「Aug 15, 2023, 12:34 PM」）。
 * 解釈できなければ空文字。
 */
export function formatCapturedDate(raw: string | null | undefined, locale: Locale): string {
  const p = parseCapturedDate(raw);
  if (!p) return '';
  const showTime = p.hasTime && (p.hour !== 0 || p.minute !== 0 || p.second !== 0);
  const d = new Date(0);
  d.setUTCFullYear(p.year, p.month - 1, p.day);
  d.setUTCHours(showTime ? p.hour : 0, showTime ? p.minute : 0, 0, 0);
  // 新しい ICU は AM/PM の前に U+202F（狭い改行しないスペース）を入れる。コピーした時に
  // 見分けのつかない空白が混ざらないよう通常の空白へ揃える。
  return getFormatter(locale, showTime).format(d).replace(NARROW_SPACES, ' ');
}
