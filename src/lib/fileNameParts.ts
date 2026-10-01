// #114: ファイル名の「中間省略」用の分割。
//
// CSS だけでは文字列の中間を省略できない（`text-overflow: ellipsis` は末尾のみ）ので、
// ファイル名を「縮んで末尾を `…` で省略される前半（head）」と「常に見える後半（tail）」に分ける。
// tail は拡張子と、その直前の数文字（連番・日付の末尾で区別がつくことが多い）。
// 例: `IMG_20230815_123456_0815.jpg` → head `IMG_20230815_123456_` / tail `0815.jpg`
// （幅が足りないと `IMG_2023…0815.jpg` のように見える）。
// 表示は head と tail を連結した元のファイル名と同じ文字列なので、選択・コピーは全文になる。

/** これ以下の長さのファイル名は分割しない（そもそも省略されにくい）。 */
const SHORT_NAME_MAX = 16;
/** 拡張子として扱う最大長（ドット込み）。それより長いものは拡張子ではなく名前の一部とみなす。 */
const EXT_MAX = 8;
/** 拡張子の前に常に残す文字数。 */
const STEM_TAIL = 4;

export interface FileNameParts {
  head: string;
  tail: string;
}

export function splitFileName(name: string): FileNameParts {
  const chars = Array.from(name);
  if (chars.length <= SHORT_NAME_MAX) return { head: name, tail: '' };
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= EXT_MAX ? name.slice(dot) : '';
  const stem = Array.from(ext ? name.slice(0, dot) : name);
  const keep = stem.slice(-STEM_TAIL).join('');
  const head = stem.slice(0, -STEM_TAIL).join('');
  if (!head) return { head: name, tail: '' };
  return { head, tail: keep + ext };
}
