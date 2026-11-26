//! Linux の Wayland セッションで、ウィンドウモードにしたときネイティブのタイトルバーを出す（#164）。
//!
//! ## 何が起きていたか
//!
//! `tauri.conf.json` はウィンドウを `decorations: false`（全画面で起動）で作る。tao 0.37 は
//! Wayland で装飾なしのウィンドウを作るとき、コンポジタにサーバー側の装飾（SSD）を描かせない
//! ために、空の `GtkEventBox` を `gtk_window_set_titlebar` でカスタムタイトルバーとして入れる。
//! 実行時の `setDecorations(true)`（JS のウィンドウモード切替と、window-state の復元）は
//! `gtk_window_set_decorated(true)` を呼ぶだけなので、GTK が表示するのはこの空の帯で、
//! タイトルも閉じるボタンも無く、掴んで動かすこともできない（`isDecorated()` は true を返す）。
//! X11（`GDK_BACKEND=x11`）では tao がこの帯を入れないため、ウィンドウマネージャの装飾が出る。
//!
//! ## 直し方
//!
//! 起動時（`setup`）に、tao の空の帯を `GtkHeaderBar`（タイトル入り・閉じるボタン付き）へ
//! 差し替える。GTK 3.24 の `gtk_window_set_titlebar` は「既にタイトルバーがあるウィンドウの
//! タイトルバーを別のものに替える」だけなら unrealize しないので、表示済みの WebView を壊さない。
//! 表示/非表示は GTK 自身が「装飾あり かつ 全画面でない」で切り替える（`update_csd_visibility`）
//! ため、JS 側の `setFullscreen`/`setDecorations` と window-state の復元はそのまま効く。
//! ヘッダーバーはウィンドウのドラッグ・ダブルクリックでの最大化・閉じるボタンを GTK の標準で持つ。
//!
//! 差し替えるのは「Wayland で、tao の空の帯（`GtkEventBox`）がタイトルバーに入っている」時だけ。
//! X11・Windows・macOS、装飾ありで作ったウィンドウには何もしない。

/// tao の空のタイトルバーをヘッダーバーへ差し替えるべきか。
///
/// `is_wayland` は GDK のバックエンドが Wayland か、`has_placeholder_titlebar` は
/// ウィンドウのカスタムタイトルバーが tao の入れた空の `GtkEventBox` か。
pub fn should_install_header_bar(is_wayland: bool, has_placeholder_titlebar: bool) -> bool {
    is_wayland && has_placeholder_titlebar
}

/// 差し替えた直後のヘッダーバーを見せるか。GTK の `update_csd_visibility` と同じ条件
/// （装飾あり かつ 全画面でない）。差し替えの時点では GTK はまだ再計算しないため、
/// 全画面で起動した直後に帯が一瞬見えないよう、こちらで初期値を合わせる。
pub fn header_bar_visible(decorated: bool, fullscreen: bool) -> bool {
    decorated && !fullscreen
}

/// メインウィンドウのタイトルバーを、条件を満たす時だけヘッダーバーへ差し替える（Linux 専用）。
/// GTK の呼び出しなのでメインスレッド（`setup` 内）から呼ぶ。失敗しても起動は続ける。
#[cfg(target_os = "linux")]
pub fn install_native_titlebar<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    use gtk::prelude::*;

    let gtk_window = match window.gtk_window() {
        Ok(w) => w,
        Err(e) => {
            eprintln!("Failed to get GTK window for titlebar setup: {e}");
            return;
        }
    };
    let is_wayland = gtk_window.display().backend().is_wayland();
    let has_placeholder = gtk_window
        .titlebar()
        .is_some_and(|w| w.is::<gtk::EventBox>());
    if !should_install_header_bar(is_wayland, has_placeholder) {
        return;
    }

    let header = gtk::HeaderBar::new();
    header.set_show_close_button(true);
    // set_titlebar はヘッダーバーのタイトルをウィンドウへ写すので、先に今のタイトルを入れる。
    // 以後の set_title（JS の setTitle）は GTK がヘッダーバーへ反映する。
    header.set_title(gtk_window.title().as_deref());
    gtk_window.set_titlebar(Some(&header));

    let fullscreen = gtk_window
        .window()
        .is_some_and(|w| w.state().contains(gtk::gdk::WindowState::FULLSCREEN));
    header.set_child_visible(header_bar_visible(gtk_window.is_decorated(), fullscreen));
    header.show();
}

/// Linux 以外では何もしない（Windows・macOS はネイティブの装飾が実行時の切替で出る）。
#[cfg(not(target_os = "linux"))]
pub fn install_native_titlebar<R: tauri::Runtime>(_window: &tauri::WebviewWindow<R>) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_only_tao_placeholder_on_wayland() {
        assert!(should_install_header_bar(true, true));
        // X11 では tao が帯を入れずウィンドウマネージャの装飾が出るので触らない
        assert!(!should_install_header_bar(false, true));
        assert!(!should_install_header_bar(false, false));
        // 装飾ありで作ったウィンドウ（帯なし）や、既にヘッダーバーがある場合も触らない
        assert!(!should_install_header_bar(true, false));
    }

    #[test]
    fn header_bar_shows_only_when_decorated_and_windowed() {
        assert!(header_bar_visible(true, false));
        assert!(!header_bar_visible(true, true));
        assert!(!header_bar_visible(false, false));
        assert!(!header_bar_visible(false, true));
    }
}
