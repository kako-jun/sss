// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { setLanguageSetting } from './store';
import {
  resolveScanErrorMessage,
  resolveAddPatternErrorMessage,
  resolveResetAllDataErrorMessage,
  resolvePickErrorMessage,
} from './errors';

/**
 * #80: バックエンドのエラーコード→表示文言の変換をピンで留める独立ユニットテスト。
 *
 * これまで `resolveScanErrorMessage`/`resolveAddPatternErrorMessage`/
 * `resolveResetAllDataErrorMessage` はコンポーネントテスト（ScanSection/
 * ExcludeRulesSection/InfoSection）経由でしか触られておらず、各スイッチの
 * 全分岐（既知コード全種・未知コードのフォールバック挙動の違い）は網羅されて
 * いなかった。ここで直接、既知コード・detail付きコード・未知コードの3種を
 * 関数ごとに固定する。
 */
describe('backend error code -> message resolution (#80)', () => {
  describe('resolveScanErrorMessage', () => {
    it('translates "scanInProgress"', () => {
      expect(resolveScanErrorMessage('scanInProgress', '/photos')).toBe(
        'スキャン実行中です。完了までお待ちください。',
      );
    });

    it('translates "directoryNotFound" and interpolates the given path', () => {
      expect(resolveScanErrorMessage('directoryNotFound', '/missing')).toBe(
        '指定したフォルダが見つかりません: /missing',
      );
    });

    it('translates "directoryUnsafe" and interpolates the given path', () => {
      expect(resolveScanErrorMessage('directoryUnsafe', '/etc')).toBe(
        'セキュリティ上の理由でこのフォルダは使用できません: /etc',
      );
    });

    it('falls back to showing an unrecognized code as-is (not the generic fallback message)', () => {
      expect(resolveScanErrorMessage('someFutureCode', '/x')).toBe('someFutureCode');
    });

    it('ignores an unexpected ":detail" suffix on a known code with no {detail} placeholder', () => {
      // directoryNotFoundの文言に{detail}は無い。コード側にdetailが付いていても、
      // pathパラメータの補間だけが行われ、detail自体は捨てられる。
      expect(resolveScanErrorMessage('directoryNotFound:unexpected', '/missing')).toBe(
        '指定したフォルダが見つかりません: /missing',
      );
    });
  });

  describe('resolvePickErrorMessage', () => {
    it('translates the #87 rejection codes', () => {
      expect(resolvePickErrorMessage('pathNotManaged')).toBe(
        'このファイルはスライドショーの管理外のためコピーできません',
      );
      expect(resolvePickErrorMessage('notMediaFile')).toBe(
        '画像・動画ファイルではないためコピーできません',
      );
    });

    it('falls back to the generic copy-failed message for unknown errors', () => {
      expect(resolvePickErrorMessage('Failed to copy file: disk full')).toBe('エラー: コピー失敗');
    });
  });

  describe('resolveAddPatternErrorMessage', () => {
    it('translates "patternEmpty"', () => {
      expect(resolveAddPatternErrorMessage('patternEmpty')).toBe('パターンを入力してください');
    });

    it('translates "invalidPattern:{detail}" and interpolates the detail', () => {
      expect(resolveAddPatternErrorMessage('invalidPattern:unclosed alternate group')).toBe(
        '無効なパターンです: unclosed alternate group',
      );
    });

    it('translates "invalidPattern" with no detail suffix to an empty {detail}', () => {
      expect(resolveAddPatternErrorMessage('invalidPattern')).toBe('無効なパターンです: ');
    });

    it('splits "invalidPattern:detail" only at the first colon (detail may itself contain colons)', () => {
      expect(resolveAddPatternErrorMessage('invalidPattern:unexpected token: "{"')).toBe(
        '無効なパターンです: unexpected token: "{"',
      );
    });

    it('translates "addIgnoreRuleFailed"', () => {
      expect(resolveAddPatternErrorMessage('addIgnoreRuleFailed')).toBe(
        '除外ルールの追加に失敗しました',
      );
    });

    it('falls back to the generic "addPatternFailedGeneric" message for an unrecognized code (unlike resolveScanErrorMessage, which echoes the raw code)', () => {
      expect(resolveAddPatternErrorMessage('someFutureCode')).toBe('パターンの追加に失敗しました');
    });
  });

  describe('resolveResetAllDataErrorMessage', () => {
    it('translates "scanInProgress"', () => {
      expect(resolveResetAllDataErrorMessage('scanInProgress')).toBe(
        'スキャン実行中です。完了までお待ちください。',
      );
    });

    it('translates "dbResetFailed"', () => {
      expect(resolveResetAllDataErrorMessage('dbResetFailed')).toBe(
        'データベースの初期化に失敗しました',
      );
    });

    it('falls back to showing an unrecognized code as-is', () => {
      expect(resolveResetAllDataErrorMessage('someFutureCode')).toBe('someFutureCode');
    });
  });

  describe('locale-following (en)', () => {
    it('resolves the same codes to English text once the locale is switched', () => {
      setLanguageSetting('en');
      expect(resolveScanErrorMessage('directoryNotFound', '/missing')).toBe(
        "Couldn't find the selected folder: /missing",
      );
      expect(resolveAddPatternErrorMessage('invalidPattern:bad token')).toBe(
        'Invalid pattern: bad token',
      );
      expect(resolveResetAllDataErrorMessage('dbResetFailed')).toBe('Failed to reset the database');
    });
  });
});
