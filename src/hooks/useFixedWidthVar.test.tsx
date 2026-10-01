// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { useRef } from 'react';
import { useFixedWidthVar } from './useFixedWidthVar';

// #114: 後半(data-fixed)の実測幅を --fw に入れ、ResizeObserver で追従する。

let width = 40;
const instances: Array<{
  cb: () => void;
  observe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}> = [];

class MockRO {
  cb: () => void;
  observe = vi.fn();
  disconnect = vi.fn();
  constructor(cb: () => void) {
    this.cb = cb;
    instances.push(this);
  }
}

function Row({ show = true, dep = 0 }: { show?: boolean; dep?: number }) {
  const ref = useRef<HTMLElement>(null);
  useFixedWidthVar(ref, [show, dep]);
  return (
    <span ref={ref} data-testid="row">
      {show && (
        <span
          data-fixed
          ref={(el) => {
            if (el)
              el.getBoundingClientRect = () =>
                ({ width }) as ReturnType<HTMLElement['getBoundingClientRect']>;
          }}
        >
          tail
        </span>
      )}
    </span>
  );
}

afterEach(() => {
  instances.length = 0;
  width = 40;
  vi.unstubAllGlobals();
});

describe('useFixedWidthVar (#114)', () => {
  it('sets --fw from the fixed part width (rounded up) and follows ResizeObserver', () => {
    vi.stubGlobal('ResizeObserver', MockRO);
    width = 40.2;
    const { getByTestId } = render(<Row />);
    const row = getByTestId('row');
    expect(row.style.getPropertyValue('--fw')).toBe('41px');
    expect(instances).toHaveLength(1);
    expect(instances[0].observe).toHaveBeenCalledTimes(1);
    width = 90;
    instances[0].cb();
    expect(row.style.getPropertyValue('--fw')).toBe('90px');
  });

  it('disconnects on unmount', () => {
    vi.stubGlobal('ResizeObserver', MockRO);
    const { unmount } = render(<Row />);
    unmount();
    expect(instances[0].disconnect).toHaveBeenCalledTimes(1);
  });

  it('disconnects and clears --fw when the fixed part goes away, and observes again when it returns', () => {
    vi.stubGlobal('ResizeObserver', MockRO);
    const { getByTestId, rerender } = render(<Row show />);
    const row = getByTestId('row');
    rerender(<Row show={false} />);
    expect(instances[0].disconnect).toHaveBeenCalledTimes(1);
    expect(row.style.getPropertyValue('--fw')).toBe('');
    rerender(<Row show />);
    expect(instances).toHaveLength(2);
    expect(instances[1].observe).toHaveBeenCalledTimes(1);
    expect(row.style.getPropertyValue('--fw')).toBe('40px');
  });

  it('does not throw when ResizeObserver is undefined (still sets --fw once)', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const { getByTestId } = render(<Row />);
    expect(getByTestId('row').style.getPropertyValue('--fw')).toBe('40px');
  });
});
