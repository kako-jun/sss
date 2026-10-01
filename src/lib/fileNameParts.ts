// #114: ファイル名の「中間省略」用の分割。
//
// CSS だけでは文字列の中間を省略できない（`text-overflow: ellipsis` は末尾のみ）ので、
// ファイル名を「縮んで末尾を `…` で省略される前半（head）」と「常に見える後半（tail）」に分ける。
// tail は拡張子と、その直前の数文字（連番・日付の末尾で区別がつくことが多い）。
// 例: `IMG_20230815_123456_0815.jpg` → head `IMG_20230815_123456_` / tail `0815.jpg`
// （幅が足りないと `IMG_2023…0815.jpg` のように見える）。
// head + tail は常に元のファイル名と一致する。
//
// 分割は書記素クラスタ（ユーザーが1文字と感じる単位）の境界で行う。結合文字・ZWJ 絵文字
// （家族絵文字など）・国旗・ハングル/タイ文字の合成を head と tail の境界で割らないため。
// RTL（ヘブライ語・アラビア語）のファイル名は、head と tail を別ボックスにすると視覚順が
// 逆転するので分割しない（通常の末尾省略 + `dir="auto"` で表示する）。

/** これ以下の長さ（書記素数）のファイル名は分割しない（そもそも省略されにくい）。 */
const SHORT_NAME_MAX = 16;
/** 拡張子として扱う最大長（ドット込み）。それより長いものは拡張子ではなく名前の一部とみなす。 */
const EXT_MAX = 8;
/** 拡張子の前に常に残す書記素数。 */
const STEM_TAIL = 4;

export interface FileNameParts {
  head: string;
  tail: string;
}

const RTL_CHARS = new RegExp('[\\u0590-\\u08FF\\uFB1D-\\uFDFF\\uFE70-\\uFEFF]');

/** ヘブライ語・アラビア語など右から左へ書く文字を含むか。 */
export function isRtlName(name: string): boolean {
  return RTL_CHARS.test(name);
}

// 結合文字・ZWJ・異体字・肌色修飾を意図して文字クラスに並べている。
/* eslint-disable no-misleading-character-class */
const EXTEND = new RegExp(
  '^[\\p{M}\\u200D\\uFE00-\\uFE0F\\u{1F3FB}-\\u{1F3FF}\\u{E0020}-\\u{E007F}]',
  'u',
);
/* eslint-enable no-misleading-character-class */
const REGIONAL = /^[\u{1F1E6}-\u{1F1FF}]$/u;

/** Intl.Segmenter が無い環境向けの簡易書記素分割（結合文字・ZWJ・異体字・肌色・国旗）。 */
export function fallbackGraphemes(s: string): string[] {
  const out: string[] = [];
  for (const cp of Array.from(s)) {
    const prev = out[out.length - 1];
    if (prev !== undefined) {
      const prevLast = Array.from(prev).pop()!;
      const prevRegionals = Array.from(prev).filter((c) => REGIONAL.test(c)).length;
      const joinsRegional = REGIONAL.test(cp) && REGIONAL.test(prevLast) && prevRegionals % 2 === 1;
      if (EXTEND.test(cp) || prevLast === '‍' || joinsRegional) {
        out[out.length - 1] = prev + cp;
        continue;
      }
    }
    out.push(cp);
  }
  return out;
}

let segmenter: { segment(s: string): Iterable<{ segment: string }> } | null | undefined;

export function graphemes(s: string): string[] {
  if (segmenter === undefined) {
    const Seg = (
      Intl as unknown as {
        Segmenter?: new (l?: string, o?: { granularity: string }) => typeof segmenter;
      }
    ).Segmenter;
    segmenter = Seg ? (new Seg(undefined, { granularity: 'grapheme' }) as typeof segmenter) : null;
  }
  if (!segmenter) return fallbackGraphemes(s);
  return Array.from(segmenter.segment(s), (x) => x.segment);
}

export function splitFileName(name: string): FileNameParts {
  if (isRtlName(name)) return { head: name, tail: '' };
  const all = graphemes(name);
  if (all.length <= SHORT_NAME_MAX) return { head: name, tail: '' };
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= EXT_MAX ? name.slice(dot) : '';
  const stem = graphemes(ext ? name.slice(0, dot) : name);
  const keep = stem.slice(-STEM_TAIL).join('');
  const head = stem.slice(0, -STEM_TAIL).join('');
  if (!head) return { head: name, tail: '' };
  return { head, tail: keep + ext };
}
