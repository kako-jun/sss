// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { useRef, useState } from 'react';
import { useFocusTrap } from './useFocusTrap';

// #66レビューmust2(c): 歯車アイコンをマウスでクリックして設定を開き、ESCで
// 閉じると、旧実装は同じ歯車ボタンへフォーカスを戻していた。その状態でSpaceを
// 押すと、ボタンのネイティブなクリック相当の挙動が働き設定が再度開いてしまって
// いた。マウス操作で得たフォーカスは`:focus-visible`にならないため、開いた瞬間に
// これを判定しておき、キーボード操作で開かれた時だけ復帰する（マウスなら
// blurする）ことを固定する。

function Modal({ isOpen }: { isOpen: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, isOpen);
  if (!isOpen) return null;
  return (
    <div ref={ref} tabIndex={-1} role="dialog">
      <button data-testid="inside">inside</button>
    </div>
  );
}

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button data-testid="trigger" onClick={() => setOpen(true)}>
        open
      </button>
      <Modal isOpen={open} />
      {open && (
        <button data-testid="close" onClick={() => setOpen(false)}>
          close
        </button>
      )}
    </div>
  );
}

async function flushRaf() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useFocusTrap opened-via-keyboard focus restoration (#66レビューmust2(c))', () => {
  // #66レビューmust2(c)の検証は、閉じた後の最終的な`document.activeElement`
  // ではなく「クリーンアップが`trigger.focus()`と`trigger.blur()`のどちらを
  // 呼んだか」で行う。React 19のpassive effect（useEffectのcleanup）は対象
  // コンポーネントのアンマウント（DOM除去）より後に走るため、jsdom環境では
  // 除去済み要素にフォーカスが残るかどうかの最終状態がブラウザと一致しない
  // ことがある（除去された要素への操作の扱いがブラウザ実装依存）。呼び出し
  // 自体（このhookが実際に何を選んだか）を直接見る方が決定的で、実際の
  // ブラウザでの見え方はe2eが担当する。
  it('calls focus() (not blur()) on the trigger when it was :focus-visible at open time (keyboard-driven open)', async () => {
    const { getByTestId } = render(<Harness />);
    const trigger = getByTestId('trigger') as HTMLButtonElement;
    trigger.focus();
    // キーボード操作で得たフォーカスをシミュレート。
    vi.spyOn(trigger, 'matches').mockReturnValue(true);
    const focusSpy = vi.spyOn(trigger, 'focus');
    const blurSpy = vi.spyOn(trigger, 'blur');

    act(() => {
      trigger.click();
    });
    await flushRaf();

    act(() => {
      // モーダルを閉じる（App.tsxのESCハンドラがsetIsOpen(false)する代わり）。
      (getByTestId('close') as HTMLButtonElement).click();
    });

    expect(focusSpy).toHaveBeenCalled();
    expect(blurSpy).not.toHaveBeenCalled();
  });

  it('calls blur() (not focus()) on the trigger when it was NOT :focus-visible at open time (mouse-driven open)', async () => {
    const { getByTestId } = render(<Harness />);
    const trigger = getByTestId('trigger') as HTMLButtonElement;
    trigger.focus();
    // マウスクリックによる残留フォーカスをシミュレート。#66レビューnit
    // （テスト実装上の注記）: jsdomの`:focus-visible`は実ブラウザと異なり
    // 「現在フォーカスされているかどうか」だけで判定しており、キーボード操作か
    // マウス操作かを区別しない（=フォーカスさえしていれば常にtrueになる）。
    // そのままでは「マウス操作」ケースを再現できないため、明示的にfalseへ
    // スタブして意図した分岐を強制する（実ブラウザでの実際の判定はe2eが担当）。
    vi.spyOn(trigger, 'matches').mockReturnValue(false);
    const focusSpy = vi.spyOn(trigger, 'focus');
    const blurSpy = vi.spyOn(trigger, 'blur');

    act(() => {
      trigger.click();
    });
    await flushRaf();

    act(() => {
      (getByTestId('close') as HTMLButtonElement).click();
    });

    // #66レビューmust2(c)の核心: 復帰させると、その後Spaceでボタンが
    // 再度押されてしまう。復帰させない（blurする）ことを固定する。
    expect(blurSpy).toHaveBeenCalled();
    expect(focusSpy).not.toHaveBeenCalled();
  });
});
