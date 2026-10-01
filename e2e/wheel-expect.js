/**
 * #124: 実ホイール連打の「期待ナビゲーション回数」を、ページ内で記録した各イベントの
 * 到達時刻（ms、e.timeStamp）から求める純関数。アプリの畳み込み（`createWheelNavigator`）は
 * 「直前のイベントから quietMs 以上空くと新しい塊」「塊の先頭で閾値を超えれば1回だけ移動」なので、
 * 期待回数 = 1 + (隣り合うイベントの間隔が quietMs 以上の回数)。負荷でイベントの到達が遅れて
 * 塊が割れても、割れ方どおりに期待値が増えるので負荷に依らず判定できる。
 * 各イベントの delta が閾値以上であることが前提（e2e は 100px、閾値は 40px）。
 */
export function expectedWheelNavigations(stamps, quietMs = 200) {
  if (stamps.length === 0) return 0;
  return stamps.reduce((n, t, i) => (i > 0 && t - stamps[i - 1] >= quietMs ? n + 1 : n), 1);
}
