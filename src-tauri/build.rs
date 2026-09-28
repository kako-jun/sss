fn main() {
    tauri_build::build();

    #[cfg(windows)]
    embed_test_manifest();
}

/// PR#83レビュー: `tests/*.rs`（`tauri::test::mock_app`/`mock_builder`使用）の
/// integration test バイナリが Windows で起動時に
/// `STATUS_ENTRYPOINT_NOT_FOUND`（0xc0000139）で異常終了する既知の tauri 側バグ
/// （tauri-apps/tauri#13419, まだ未修正）への対処。
///
/// `tauri_build::build()` がアプリ本体バイナリに埋め込む Windows マニフェスト
/// （Common Controls v6 宣言、tao/wry が要求）は、内部で
/// `embed-resource` の `compile()`（`compile_for_everything()` ではない）を
/// 経由するため `cargo:rustc-link-arg-bins` 相当でしか適用されず、
/// `cargo test` が作る `tests/` 配下の integration test バイナリには届かない。
/// マニフェストの無い状態だと Windows は comctl32 の古い実装（v5.82、
/// `TaskDialogIndirect` 等 tao/wry が使う v6 専用シンボルを含まない）を
/// 代わりに読み込み、エントリポイント解決に失敗してプロセスがロード時点で
/// 落ちる（1テストも実行されずに `cargo test` 自体が失敗する）。
///
/// 対策として、同じ内容のマニフェストを `cargo:rustc-link-arg-tests` で
/// integration test バイナリにのみ追加リンクする。`-tests` サフィックスは
/// `tests/` 配下の各テストにのみ適用され、アプリ本体（`-bins`）には影響しない
/// ため、アプリ本体側で二重にマニフェストが埋め込まれる心配はない。
/// なお `src/` 内の `#[cfg(test)]`（lib unit test バイナリ）は
/// `tauri::test::mock_app` を使っていない（`AppHandle` の runtime が `Wry` 固定で
/// `MockRuntime` を受け付けないため、フックできる関数はロジック本体を直接
/// テストしている）ので、`-tests` だけでこのリポジトリの範囲は網羅できる。
#[cfg(windows)]
fn embed_test_manifest() {
    let manifest = concat!(env!("CARGO_MANIFEST_DIR"), "/windows-test-manifest.xml");
    println!("cargo:rerun-if-changed={manifest}");
    println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg-tests=/MANIFESTINPUT:{manifest}");
}
