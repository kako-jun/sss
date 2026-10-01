import process from 'node:process';
import { describe, it, expect, afterEach } from 'vitest';
import { formatCapturedDate, parseCapturedDate } from './formatCapturedDate';

// #114: 撮影日のロケール整形。EXIF の日時はタイムゾーンを持たない壁時計の値なので、
// 実行環境の TZ に関わらず年月日時分が一切ずれないことを重点的に固定する。

describe('formatCapturedDate (#114)', () => {
  describe('ja', () => {
    it.each([
      ['2023-08-15T12:34:56', '2023年8月15日 12:34'],
      ['2023-08-15 12:34:56', '2023年8月15日 12:34'],
      ['2023:08:15 12:34:56', '2023年8月15日 12:34'],
      ['2023-08-15T12:34', '2023年8月15日 12:34'],
    ])('formats %s', (raw, expected) => {
      expect(formatCapturedDate(raw, 'ja')).toBe(expected);
    });

    it('uses 24-hour time with no AM/PM, and keeps the minute zero-padded', () => {
      expect(formatCapturedDate('2023-08-15 00:05:09', 'ja')).toBe('2023年8月15日 00:05');
      expect(formatCapturedDate('2023-08-15 23:59:59', 'ja')).toBe('2023年8月15日 23:59');
      expect(formatCapturedDate('2023-08-15 09:07:00', 'ja')).toBe('2023年8月15日 09:07');
    });
  });

  describe('en', () => {
    it.each([
      ['2023-08-15T12:34:56', 'Aug 15, 2023, 12:34 PM'],
      ['2023:08:15 12:34:56', 'Aug 15, 2023, 12:34 PM'],
      ['2023-08-15 00:05:09', 'Aug 15, 2023, 12:05 AM'],
      ['2023-08-15 11:59:59', 'Aug 15, 2023, 11:59 AM'],
      ['2023-08-15 12:00:00', 'Aug 15, 2023, 12:00 PM'],
      ['2023-08-15 23:59:59', 'Aug 15, 2023, 11:59 PM'],
      ['2023-08-15 01:02:03', 'Aug 15, 2023, 1:02 AM'],
    ])('formats %s (AM/PM boundaries)', (raw, expected) => {
      expect(formatCapturedDate(raw, 'en')).toBe(expected);
    });

    it('uses a plain space before AM/PM (not U+202F), so copied text is clean', () => {
      expect(formatCapturedDate('2023-08-15 12:34:56', 'en')).not.toMatch(
        new RegExp('[\\u202f\\u00a0]'),
      );
    });
  });

  describe('date only / midnight', () => {
    it('omits the time when only a date is given', () => {
      expect(formatCapturedDate('2023-08-15', 'ja')).toBe('2023年8月15日');
      expect(formatCapturedDate('2023-08-15', 'en')).toBe('Aug 15, 2023');
      expect(formatCapturedDate('2023:08:15', 'ja')).toBe('2023年8月15日');
    });

    it('omits the time at exactly 00:00:00 (time is usually unknown)', () => {
      expect(formatCapturedDate('2023-08-15 00:00:00', 'ja')).toBe('2023年8月15日');
      expect(formatCapturedDate('2023-08-15T00:00:00', 'en')).toBe('Aug 15, 2023');
      expect(formatCapturedDate('2023-08-15T00:00', 'en')).toBe('Aug 15, 2023');
    });

    it('still shows the time for 00:00:xx with non-zero seconds', () => {
      expect(formatCapturedDate('2023-08-15 00:00:30', 'ja')).toBe('2023年8月15日 00:00');
    });
  });

  describe('calendar edges', () => {
    it('handles year boundaries', () => {
      expect(formatCapturedDate('2023-12-31 23:59:59', 'ja')).toBe('2023年12月31日 23:59');
      expect(formatCapturedDate('2024-01-01 00:00:01', 'ja')).toBe('2024年1月1日 00:00');
      expect(formatCapturedDate('2023-12-31 23:59:59', 'en')).toBe('Dec 31, 2023, 11:59 PM');
    });

    it('handles month ends and leap days', () => {
      expect(formatCapturedDate('2023-01-31', 'en')).toBe('Jan 31, 2023');
      expect(formatCapturedDate('2024-02-29', 'ja')).toBe('2024年2月29日');
      expect(formatCapturedDate('2000-02-29', 'en')).toBe('Feb 29, 2000');
    });

    it('rejects days that do not exist', () => {
      expect(formatCapturedDate('2023-02-29', 'ja')).toBe('');
      expect(formatCapturedDate('1900-02-29', 'ja')).toBe('');
      expect(formatCapturedDate('2023-04-31', 'ja')).toBe('');
      expect(formatCapturedDate('2023-02-30 10:00:00', 'en')).toBe('');
    });
  });

  describe('time zone handling', () => {
    it('ignores an explicit offset / Z and shows the wall-clock value as written', () => {
      expect(formatCapturedDate('2023-08-15T12:34:56Z', 'ja')).toBe('2023年8月15日 12:34');
      expect(formatCapturedDate('2023-08-15T12:34:56+09:00', 'ja')).toBe('2023年8月15日 12:34');
      expect(formatCapturedDate('2023-08-15T12:34:56-0500', 'en')).toBe('Aug 15, 2023, 12:34 PM');
      expect(formatCapturedDate('2023-08-15T23:30:00+09', 'en')).toBe('Aug 15, 2023, 11:30 PM');
      expect(formatCapturedDate('2023-08-15T12:34:56.789Z', 'ja')).toBe('2023年8月15日 12:34');
    });

    describe('does not shift the date in any runtime time zone', () => {
      const original = process.env.TZ;
      afterEach(() => {
        if (original === undefined) delete process.env.TZ;
        else process.env.TZ = original;
      });

      it.each([
        'UTC',
        'Asia/Tokyo',
        'America/Los_Angeles',
        'Pacific/Kiritimati',
        'Pacific/Pago_Pago',
      ])('%s', (tz) => {
        process.env.TZ = tz;
        // 日付のみ（new Date('2023-08-15') は UTC 解釈）も、時刻付き（ローカル解釈）も、
        // 年跨ぎ直前直後も、どの TZ でも書かれたとおりに出る。
        expect(formatCapturedDate('2023-08-15', 'ja')).toBe('2023年8月15日');
        expect(formatCapturedDate('2023-08-15T00:30:00', 'ja')).toBe('2023年8月15日 00:30');
        expect(formatCapturedDate('2023-08-15T23:30:00', 'ja')).toBe('2023年8月15日 23:30');
        expect(formatCapturedDate('2023-12-31T23:59:59', 'en')).toBe('Dec 31, 2023, 11:59 PM');
        expect(formatCapturedDate('2024-01-01T00:00:01Z', 'en')).toBe('Jan 1, 2024, 12:00 AM');
      });
    });
  });

  describe('invalid input', () => {
    it.each([
      [''],
      ['   '],
      [null],
      [undefined],
      ['unknown'],
      ['0000:00:00 00:00:00'],
      ['0000-00-00'],
      ['2023-13-01'],
      ['2023-00-10'],
      ['2023-08-00'],
      ['2023-08-15 24:00:00'],
      ['2023-08-15 12:60:00'],
      ['2023-08-15 12:34:60'],
      ['2023/8/15'],
      ['2023-08-15T'],
      ['not a date'],
      ['2023-08-15 12:34:56 extra'],
    ])('returns an empty string for %j', (raw) => {
      expect(formatCapturedDate(raw as string | null | undefined, 'ja')).toBe('');
      expect(formatCapturedDate(raw as string | null | undefined, 'en')).toBe('');
    });

    it('tolerates surrounding whitespace and quotes', () => {
      expect(formatCapturedDate('  "2023-08-15 12:34:56"  ', 'ja')).toBe('2023年8月15日 12:34');
    });
  });
});

describe('parseCapturedDate (#114)', () => {
  it('returns the wall-clock parts', () => {
    expect(parseCapturedDate('2023:08:15 12:34:56')).toEqual({
      year: 2023,
      month: 8,
      day: 15,
      hour: 12,
      minute: 34,
      second: 56,
      hasTime: true,
    });
    expect(parseCapturedDate('2023-08-15')).toMatchObject({ hasTime: false, hour: 0 });
    expect(parseCapturedDate('x')).toBeNull();
  });
});
