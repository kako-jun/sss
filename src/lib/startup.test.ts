import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runStartupSequence, type StartupDeps } from './startup';

// #62レビューS1: 起動シーケンス（前回状態の復元→可能なら即表示、スキャンは
// バックグラウンド）を、Reactをマウントせず純粋関数として直接検証する。
// 各モックは呼ばれた順に `order` へ自分の名前を積み、呼び出し順序を固定する。

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('runStartupSequence', () => {
  it('no last directory: marks initialized immediately without restoring or scanning', async () => {
    const order: string[] = [];

    const deps: StartupDeps = {
      getSetting: async () => null,
      getLastDirectoryPath: async () => {
        order.push('getLastDirectoryPath');
        return null;
      },
      restorePlaylist: async () => {
        order.push('restorePlaylist');
        return false;
      },
      scanDirectory: async () => {
        order.push('scanDirectory');
        return { totalFiles: 0 };
      },
      initialize: async () => {
        order.push('initialize');
      },
      listenScanProgress: async () => () => {},
      setInitStatus: () => {},
      setRealtimeProgress: () => {},
      setIsInitialized: (v) => order.push(`setIsInitialized:${v}`),
      setDisplayInterval: () => {},
      updatePlaylistInfo: async () => {
        order.push('updatePlaylistInfo');
      },
    };

    await runStartupSequence(deps);

    expect(order).toEqual(['getLastDirectoryPath', 'setIsInitialized:true']);
  });

  it('restore succeeds: initializes immediately and runs scan in the background (not awaited)', async () => {
    const scanDeferred = deferred<{ totalFiles: number }>();
    const order: string[] = [];

    const deps: StartupDeps = {
      getSetting: async () => null,
      getLastDirectoryPath: async () => '/photos',
      restorePlaylist: async () => {
        order.push('restorePlaylist');
        return true;
      },
      scanDirectory: async (dir) => {
        order.push(`scanDirectory:${dir}`);
        return scanDeferred.promise;
      },
      initialize: async () => {
        order.push('initialize');
      },
      listenScanProgress: async () => () => {},
      setInitStatus: () => {},
      setRealtimeProgress: () => {},
      setIsInitialized: (v) => order.push(`setIsInitialized:${v}`),
      setDisplayInterval: () => {},
      updatePlaylistInfo: async () => {
        order.push('updatePlaylistInfo');
      },
    };

    await runStartupSequence(deps);
    // バックグラウンドの `runScanWithProgress` 呼び出し内部の最初の await
    // （`listenScanProgress`）が進むまでマイクロタスクを数回流す。
    await Promise.resolve();
    await Promise.resolve();

    // この時点では、スキャンは開始されているがまだ完了していない
    // （バックグラウンドで走っている＝待っていない証拠）。
    expect(order).toEqual([
      'restorePlaylist',
      'initialize',
      'setIsInitialized:true',
      'updatePlaylistInfo',
      'scanDirectory:/photos',
    ]);

    // スキャンを完了させると、その後にもう一度updatePlaylistInfoが呼ばれる。
    scanDeferred.resolve({ totalFiles: 5 });
    await scanDeferred.promise;
    // background .then() チェーンが走る猶予を与える
    await Promise.resolve();
    await Promise.resolve();

    expect(order).toEqual([
      'restorePlaylist',
      'initialize',
      'setIsInitialized:true',
      'updatePlaylistInfo',
      'scanDirectory:/photos',
      'updatePlaylistInfo',
    ]);
  });

  it('restore fails (no saved state / directory mismatch): waits for scan before initializing', async () => {
    const order: string[] = [];

    const deps: StartupDeps = {
      getSetting: async () => null,
      getLastDirectoryPath: async () => '/photos',
      restorePlaylist: async () => {
        order.push('restorePlaylist');
        return false;
      },
      scanDirectory: async (dir) => {
        order.push(`scanDirectory:${dir}`);
        return { totalFiles: 7 };
      },
      initialize: async () => {
        order.push('initialize');
      },
      listenScanProgress: async () => () => {},
      setInitStatus: () => {},
      setRealtimeProgress: () => {},
      setIsInitialized: (v) => order.push(`setIsInitialized:${v}`),
      setDisplayInterval: () => {},
      updatePlaylistInfo: async () => {
        order.push('updatePlaylistInfo');
      },
    };

    await runStartupSequence(deps);

    expect(order).toEqual([
      'restorePlaylist',
      'scanDirectory:/photos',
      'initialize',
      'setIsInitialized:true',
      'updatePlaylistInfo',
    ]);
  });

  it('restorePlaylist throwing falls back to the scan-and-wait flow instead of crashing', async () => {
    const order: string[] = [];

    const deps: StartupDeps = {
      getSetting: async () => null,
      getLastDirectoryPath: async () => '/photos',
      restorePlaylist: async () => {
        order.push('restorePlaylist');
        throw new Error('boom');
      },
      scanDirectory: async () => {
        order.push('scanDirectory');
        return { totalFiles: 1 };
      },
      initialize: async () => {
        order.push('initialize');
      },
      listenScanProgress: async () => () => {},
      setInitStatus: () => {},
      setRealtimeProgress: () => {},
      setIsInitialized: (v) => order.push(`setIsInitialized:${v}`),
      setDisplayInterval: () => {},
      updatePlaylistInfo: async () => {
        order.push('updatePlaylistInfo');
      },
    };

    await runStartupSequence(deps);

    expect(order).toEqual([
      'restorePlaylist',
      'scanDirectory',
      'initialize',
      'setIsInitialized:true',
      'updatePlaylistInfo',
    ]);
  });

  it('scan failing after a failed restore still marks initialized (does not hang)', async () => {
    const order: string[] = [];

    const deps: StartupDeps = {
      getSetting: async () => null,
      getLastDirectoryPath: async () => '/photos',
      restorePlaylist: async () => false,
      scanDirectory: async () => {
        throw new Error('scan failed');
      },
      initialize: async () => {
        order.push('initialize');
      },
      listenScanProgress: async () => () => {},
      setInitStatus: (s) => order.push(`status:${s}`),
      setRealtimeProgress: () => {},
      setIsInitialized: (v) => order.push(`setIsInitialized:${v}`),
      setDisplayInterval: () => {},
      updatePlaylistInfo: async () => {
        order.push('updatePlaylistInfo');
      },
    };

    await runStartupSequence(deps);

    expect(order.filter((c) => !c.startsWith('status:'))).toEqual(['setIsInitialized:true']);
    expect(order).not.toContain('initialize');
  });

  it('background scan failure after successful restore is caught and reported, does not throw', async () => {
    const dirErrors: unknown[] = [];
    const order: string[] = [];

    const deps: StartupDeps = {
      getSetting: async () => null,
      getLastDirectoryPath: async () => '/photos',
      restorePlaylist: async () => true,
      scanDirectory: async () => {
        throw new Error('background scan failed');
      },
      initialize: async () => {
        order.push('initialize');
      },
      listenScanProgress: async () => () => {},
      setInitStatus: () => {},
      setRealtimeProgress: () => {},
      setIsInitialized: (v) => order.push(`setIsInitialized:${v}`),
      setDisplayInterval: () => {},
      updatePlaylistInfo: async () => {
        order.push('updatePlaylistInfo');
      },
      onDirectoryError: (err) => dirErrors.push(err),
    };

    await expect(runStartupSequence(deps)).resolves.toBeUndefined();
    expect(order).toEqual(['initialize', 'setIsInitialized:true', 'updatePlaylistInfo']);

    // バックグラウンドの失敗が伝播するまで待つ
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(dirErrors).toHaveLength(1);
  });

  it('foreground scan failure (restore failed) also reports the reason via onDirectoryError (#65)', async () => {
    // #65本文コメント: 「起動時自動スキャンで前回ディレクトリが拒否された際の
    // 理由表示」。以前はcatch節でconsole.errorのみ・呼び出し元には何も伝わらなかった。
    const dirErrors: unknown[] = [];
    const order: string[] = [];
    const failure = new Error('permission denied');

    const deps: StartupDeps = {
      getSetting: async () => null,
      getLastDirectoryPath: async () => '/photos',
      restorePlaylist: async () => false,
      scanDirectory: async () => {
        throw failure;
      },
      initialize: async () => {
        order.push('initialize');
      },
      listenScanProgress: async () => () => {},
      setInitStatus: () => {},
      setRealtimeProgress: () => {},
      setIsInitialized: (v) => order.push(`setIsInitialized:${v}`),
      setDisplayInterval: () => {},
      updatePlaylistInfo: async () => {
        order.push('updatePlaylistInfo');
      },
      onDirectoryError: (err) => dirErrors.push(err),
    };

    await runStartupSequence(deps);

    expect(order).toEqual(['setIsInitialized:true']);
    expect(dirErrors).toEqual([failure]);
  });

  it('marks a directory as configured (setHasDirectory(true)) as soon as a last directory is found, regardless of outcome (#65)', async () => {
    const calls: boolean[] = [];

    const deps: StartupDeps = {
      getSetting: async () => null,
      getLastDirectoryPath: async () => '/photos',
      restorePlaylist: async () => false,
      scanDirectory: async () => {
        throw new Error('boom');
      },
      initialize: async () => {},
      listenScanProgress: async () => () => {},
      setInitStatus: () => {},
      setRealtimeProgress: () => {},
      setIsInitialized: () => {},
      setDisplayInterval: () => {},
      updatePlaylistInfo: async () => {},
      setHasDirectory: (v) => calls.push(v),
    };

    await runStartupSequence(deps);

    expect(calls).toEqual([true]);
  });

  it('does not mark a directory as configured when there is no last directory (#65: 「本当に未設定」判定)', async () => {
    const calls: boolean[] = [];

    const deps: StartupDeps = {
      getSetting: async () => null,
      getLastDirectoryPath: async () => null,
      restorePlaylist: async () => false,
      scanDirectory: async () => ({ totalFiles: 0 }),
      initialize: async () => {},
      listenScanProgress: async () => () => {},
      setInitStatus: () => {},
      setRealtimeProgress: () => {},
      setIsInitialized: () => {},
      setDisplayInterval: () => {},
      updatePlaylistInfo: async () => {},
      setHasDirectory: (v) => calls.push(v),
    };

    await runStartupSequence(deps);

    expect(calls).toEqual([]);
  });
});
