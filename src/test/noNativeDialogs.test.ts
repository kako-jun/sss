import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// #119: window.confirm/alert/prompt は Tauri（tauri_plugin_dialog）が Promise 版に差し替えるため
// 常に truthy となり確認が素通りする。また @tauri-apps/plugin-dialog の JS API は dialog 権限を
// 付与していない（#93）ので動かない。eslint（no-restricted-globals / -properties / -imports）と
// 二重で、TypeScript の構文木を走査して検出する。確認は confirmDialog() を使う。
//
// 検出する形: 裸の confirm/alert/prompt 参照、window/globalThis/self/top/parent/frames/
// document.defaultView（括弧・as キャスト越し含む）と、それを代入した別名変数への
// .confirm / ['confirm'] / 分割代入、@tauri-apps/plugin-dialog の import / require / dynamic import。
// 限界（検出できない）: 関数の戻り値や配列経由で得たグローバルオブジェクト、プロパティ名の
// 動的組み立て（obj[name]）、eval。これらは eslint でも防げないので、レビューで見ること。

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NAMES = new Set(['confirm', 'alert', 'prompt']);
const GLOBAL_OBJECTS = new Set(['window', 'globalThis', 'self', 'top', 'parent', 'frames']);
const DIALOG_MODULE = '@tauri-apps/plugin-dialog';

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
}

function unwrap(node: ts.Node): ts.Node {
  let n = node;
  while (
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isNonNullExpression(n) ||
    ts.isTypeAssertionExpression(n)
  ) {
    n = n.expression;
  }
  return n;
}

export function findViolations(source: string, fileName = 'x.tsx'): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const aliases = new Set<string>();
  const out: string[] = [];
  const report = (n: ts.Node, why: string) => {
    const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
    out.push(`${line + 1}: ${why}`);
  };
  const isGlobalObj = (node: ts.Node): boolean => {
    const n = unwrap(node);
    if (ts.isIdentifier(n)) return GLOBAL_OBJECTS.has(n.text) || aliases.has(n.text);
    if (ts.isPropertyAccessExpression(n)) {
      return (
        ts.isIdentifier(n.expression) &&
        n.expression.text === 'document' &&
        n.name.text === 'defaultView'
      );
    }
    return false;
  };

  // 1 周目: 別名（const w = window 等）を集める。
  const collect = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isGlobalObj(node.initializer)
    ) {
      aliases.add(node.name.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);

  const check = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node) && NAMES.has(node.name.text)) {
      if (isGlobalObj(node.expression)) report(node, `global .${node.name.text}`);
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      NAMES.has(node.argumentExpression.text) &&
      isGlobalObj(node.expression)
    ) {
      report(node, `global [${node.argumentExpression.text}]`);
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      isGlobalObj(node.initializer)
    ) {
      for (const el of node.name.elements) {
        const key = el.propertyName ?? el.name;
        if (ts.isIdentifier(key) && NAMES.has(key.text)) report(el, `destructured ${key.text}`);
      }
    } else if (ts.isIdentifier(node) && NAMES.has(node.text)) {
      const p = node.parent;
      const isMemberName =
        (ts.isPropertyAccessExpression(p) && p.name === node) ||
        (ts.isPropertyAssignment(p) && p.name === node) ||
        (ts.isBindingElement(p) && p.propertyName === node) ||
        ts.isPropertySignature(p) ||
        ts.isMethodDeclaration(p) ||
        ts.isPropertyDeclaration(p) ||
        ts.isJsxAttribute(p);
      const isDeclaration =
        (ts.isVariableDeclaration(p) && p.name === node) ||
        ts.isParameter(p) ||
        ts.isImportSpecifier(p) ||
        ts.isFunctionDeclaration(p) ||
        ts.isBindingElement(p);
      if (!isMemberName && !isDeclaration) report(node, `bare ${node.text}`);
    } else if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text.startsWith(DIALOG_MODULE)
    ) {
      report(node, `import ${DIALOG_MODULE}`);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      node.arguments[0].text.startsWith(DIALOG_MODULE) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      report(node, `dynamic import ${DIALOG_MODULE}`);
    }
    ts.forEachChild(node, check);
  };
  check(sf);
  return out;
}

describe('no native dialogs (#119)', () => {
  it('src never uses window.confirm/alert/prompt or @tauri-apps/plugin-dialog', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      for (const v of findViolations(readFileSync(file, 'utf8'), file)) {
        offenders.push(`${relative(SRC, file)}:${v}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  describe('detector self-check', () => {
    const bad = [
      'if (!confirm("x")) return;',
      'window.confirm("x")',
      'globalThis.alert("x")',
      'const w = window; w.confirm("x");',
      'top.confirm("x")',
      'parent.prompt("x")',
      'document.defaultView.confirm("x")',
      '(window as any).confirm("x")',
      '(window as unknown as Window)["confirm"]("x")',
      'const { confirm: c } = window;',
      'import { ask, message } from "@tauri-apps/plugin-dialog";',
      'await import("@tauri-apps/plugin-dialog");',
      'const d = require("@tauri-apps/plugin-dialog");',
      'frames.confirm("x")',
      'export { ask } from "@tauri-apps/plugin-dialog";',
    ];
    for (const code of bad) {
      it(`flags: ${code}`, () => {
        expect(findViolations(code).length).toBeGreaterThan(0);
      });
    }
    const good = [
      'await confirmDialog({ message: "x", confirmLabel: "y" });',
      'const o = { confirm: 1 }; o.confirm;',
      'foo.confirm("x")',
      '// window.confirm("x")',
      'const s = "window.confirm";',
    ];
    for (const code of good) {
      it(`allows: ${code}`, () => {
        expect(findViolations(code)).toEqual([]);
      });
    }
  });
});
