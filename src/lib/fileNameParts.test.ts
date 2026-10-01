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
