import { describe, it, expect } from 'vitest';
import { splitFileName } from './fileNameParts';

// #114: ファイル名の中間省略用の分割。head + tail は常に元のファイル名と一致する
// （選択・コピーが全文になる）。

describe('splitFileName (#114)', () => {
  it('does not split short names', () => {
    expect(splitFileName('IMG_0001.jpg')).toEqual({ head: 'IMG_0001.jpg', tail: '' });
    expect(splitFileName('a.png')).toEqual({ head: 'a.png', tail: '' });
    expect(splitFileName('')).toEqual({ head: '', tail: '' });
    // 16 文字ちょうどは分割しない
    expect(splitFileName('123456789012.jpg')).toEqual({ head: '123456789012.jpg', tail: '' });
    // 17 文字からは分割する
    expect(splitFileName('1234567890123.jpg')).toEqual({ head: '123456789', tail: '0123.jpg' });
  });

  it('keeps the extension and the last 4 stem characters in the tail', () => {
    expect(splitFileName('IMG_20230815_123456_0815.jpg')).toEqual({
      head: 'IMG_20230815_123456_',
      tail: '0815.jpg',
    });
  });

  it('keeps long extensions up to 8 chars including the dot, but not longer', () => {
    expect(splitFileName('very_long_photo_name_2023.jpeg')).toEqual({
      head: 'very_long_photo_name_',
      tail: '2023.jpeg',
    });
    // 拡張子が9文字以上（ドット込み）なら拡張子とはみなさず、名前の末尾4文字だけ残す
    expect(splitFileName('very_long_photo_name_2023.extensions')).toEqual({
      head: 'very_long_photo_name_2023.extens',
      tail: 'ions',
    });
  });

  it('handles names without an extension and dotfiles', () => {
    expect(splitFileName('a_very_long_name_without_extension')).toEqual({
      head: 'a_very_long_name_without_exten',
      tail: 'sion',
    });
    expect(splitFileName('.a_very_long_hidden_file_name')).toEqual({
      head: '.a_very_long_hidden_file_',
      tail: 'name',
    });
  });

  it('splits by code points, not UTF-16 units (Japanese and emoji-free surrogate pairs)', () => {
    expect(splitFileName('沖縄旅行の写真_美ら海水族館_ジンベエザメ_001.jpg')).toEqual({
      head: '沖縄旅行の写真_美ら海水族館_ジンベエザメ',
      tail: '_001.jpg',
    });
    // サロゲートペア（𠮷 は U+20BB7）を途中で割らない
    const name = '𠮷'.repeat(20) + '.jpg';
    const { head, tail } = splitFileName(name);
    expect(head + tail).toBe(name);
    expect(tail).toBe('𠮷𠮷𠮷𠮷.jpg');
  });

  it('always reconstructs the original name', () => {
    for (const n of [
      'IMG_20230815_123456_0815.jpg',
      'noext_noext_noext_noext',
      'a.b.c.d.e.f.g.h.i.j.k.l.m.n.o.p.png',
      '                    spaces .jpg',
      'x'.repeat(300) + '.webm',
    ]) {
      const { head, tail } = splitFileName(n);
      expect(head + tail).toBe(n);
    }
  });
});

// #114 レビュー S1: 書記素クラスタの境界で割らない / RTL は分割しない。
import { fallbackGraphemes, graphemes, isRtlName } from './fileNameParts';

describe('splitFileName keeps grapheme clusters intact (#114)', () => {
  const pad = 'a'.repeat(22);
  const family = '👨‍👩‍👧';
  const flags = '🇯🇵🇺🇸';

  it('does not split a ZWJ family emoji at the head/tail boundary', () => {
    const name = `${pad}${family}.jpg`;
    const { head, tail } = splitFileName(name);
    expect(head + tail).toBe(name);
    expect(tail).toBe(`aaa${family}.jpg`);
    // 先頭が ZWJ・異体字セレクタ・結合文字で始まる tail は不正
    // eslint-disable-next-line no-misleading-character-class
    expect(tail).not.toMatch(new RegExp('^[\\u200D\\uFE0F\\u0301]'));
    expect(head).not.toMatch(/‍$/);
  });

  it('does not split a combining sequence (e + U+0301) at any offset', () => {
    for (let n = 18; n < 26; n++) {
      const name = 'a'.repeat(n) + 'é' + 'bcd.jpg';
      const { head, tail } = splitFileName(name);
      expect(head + tail).toBe(name);
      expect(tail).not.toMatch(/^[̀-ͯ]/);
      expect(head).not.toMatch(/e$/);
    }
  });

  it('does not split flags (regional indicator pairs)', () => {
    const name = `${pad}${flags}.png`;
    const { head, tail } = splitFileName(name);
    expect(head + tail).toBe(name);
    expect(tail).toBe(`aa${flags}.png`);
  });

  it('keeps skin-tone emoji, Hangul and Thai clusters whole', () => {
    for (const unit of ['👍🏽', '한글', 'ก็', 'กำ']) {
      const name = `${pad}${unit}${unit}${unit}${unit}${unit}.jpg`;
      const { head, tail } = splitFileName(name);
      expect(head + tail).toBe(name);
      const clusters = graphemes(name);
      // 境界 head|tail が書記素の境界であること
      expect(graphemes(head).join('') + graphemes(tail).join('')).toBe(name);
      expect(clusters.join('')).toBe(name);
      expect(graphemes(head).length + graphemes(tail).length).toBe(clusters.length);
    }
  });

  it('fallback segmentation (no Intl.Segmenter) also keeps the sequences together', () => {
    expect(fallbackGraphemes(`a${family}b`)).toEqual(['a', family, 'b']);
    expect(fallbackGraphemes('aéb')).toEqual(['a', 'é', 'b']);
    expect(fallbackGraphemes(`${flags}x`)).toEqual(['🇯🇵', '🇺🇸', 'x']);
    expect(fallbackGraphemes('👍🏽')).toEqual(['👍🏽']);
  });

  it('does not split RTL names (visual order would reverse)', () => {
    const name = 'שלום_עולם_תמונה_ארוכה_מאוד_2023.jpg';
    expect(isRtlName(name)).toBe(true);
    expect(splitFileName(name)).toEqual({ head: name, tail: '' });
    expect(isRtlName('مرحبا_بالعالم_الجميل_جدا.png')).toBe(true);
    expect(isRtlName('IMG_0001.jpg')).toBe(false);
  });
});
