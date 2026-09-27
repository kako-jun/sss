import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ja } from './dictionaries/ja';
import { en } from './dictionaries/en';

/**
 * 辞書の整合性テスト（#80）。
 *
 * - ja/en のキー集合が完全一致するか
 * - 定義した辞書キーが実際にどこかで使われているか（未使用キー検出）
 * - `src/` 配下のアプリコードに日本語がハードコードされていないか（辞書を
 *   分割した意味が無くなる直書きの回帰防止）
 * - #80で辞書化する前に日本語UIと不整合な形で直書きされていた英語文字列が
 *   復活していないか
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(__dirname, '..', '..');

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listSourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const allSourceFiles = listSourceFiles(srcRoot);
// 辞書ファイル自体（値そのものが日本語/英語の文言）とテストファイル（アサーション
// 中の文言比較）は、直書き検出・未使用キー検出のどちらの対象からも除外する。
const scannedFiles = allSourceFiles.filter(
  (f) =>
    !f.includes(`${path.sep}i18n${path.sep}dictionaries${path.sep}`) && !/\.test\.tsx?$/.test(f),
);
const scannedContents = scannedFiles.map((f) => ({
  file: f,
  content: fs.readFileSync(f, 'utf-8'),
}));

describe('i18n dictionaries (#80)', () => {
  it('ja and en define exactly the same set of keys', () => {
    expect(Object.keys(ja).sort()).toEqual(Object.keys(en).sort());
  });

  it('every dictionary key is referenced somewhere in the app source (no unused keys)', () => {
    const joined = scannedContents.map((f) => f.content).join('\n');
    const unused = Object.keys(ja).filter(
      (key) => !joined.includes(`'${key}'`) && !joined.includes(`"${key}"`),
    );
    expect(unused).toEqual([]);
  });

  it('has no raw Japanese characters hardcoded outside the dictionaries', () => {
    const japanesePattern = /[぀-ヿ一-鿿]/;
    const offenders: string[] = [];
    for (const { file, content } of scannedContents) {
      // ブロックコメント（JSDocの `/** ... */`、JSXの `{/* ... */}`）は、含まれる
      // 改行の数だけの空行に置き換えて除去する（行番号がずれないように）。
      // 説明文（日本語コメント）はi18n対象外のため。
      const withoutBlockComments = content.replace(
        /\{\/\*[\s\S]*?\*\/\}|\/\*[\s\S]*?\*\//g,
        (match: string) => '\n'.repeat((match.match(/\n/g) ?? []).length),
      );
      withoutBlockComments.split('\n').forEach((line: string, i: number) => {
        // 行コメント（`//`）以降も対象外。
        const codePart = line.split('//')[0];
        if (japanesePattern.test(codePart)) {
          offenders.push(`${path.relative(srcRoot, file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('does not reintroduce hardcoded English UI strings that #80 moved into the dictionary', () => {
    // #80着手前、日本語UIの中に混在していた直書き英語（言語切替に追従できない
    // バグの実例）。辞書化後は消えているはずの文字列を列挙し、復活していないか
    // 確認する。
    const bannedLiterals = [
      "'Please select a directory first'",
      "'Failed to select directory'",
      "'Failed to scan directory'",
      "'Pattern must not be empty'",
      '`Invalid pattern: ${e}`',
      'Directory does not exist or is not a directory:',
      'Cannot use this directory for security reasons',
    ];
    const offenders: string[] = [];
    for (const { file, content } of scannedContents) {
      for (const literal of bannedLiterals) {
        if (content.includes(literal)) {
          offenders.push(`${path.relative(srcRoot, file)}: ${JSON.stringify(literal)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
