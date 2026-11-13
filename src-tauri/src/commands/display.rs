//! 表示バックエンドの判定（#164）。
//!
//! Linux の Wayland では、tao が装飾なし（`decorations: false`）でウィンドウを作るとき
//! `set_decorated(false)` のあとに空のカスタムタイトルバー（`set_titlebar(EventBox)`）を入れる
//! （tao 0.37 `platform_impl/linux/window.rs`）。実行時の `setDecorations(true)` は
//! `gtk_window.set_decorated(true)` を呼ぶだけでこの空のタイトルバーは残るため、ウィンドウモードに
//! しても OS のタイトルバーは出ないのに `isDecorated()` は true を返す（GTK の decorated
//! プロパティをそのまま返す）。フロントは `isDecorated()` では判定できないので、このコマンドで
//! バックエンドそのものを問い合わせ、Wayland ならウィンドウモード中にアプリ内のドラッグ領域を出す。

/// GDK の Display の GObject 型名が Wayland のものか（純関数。`gdk::DisplayExtManual::backend()`
/// は未知の型名で panic するため使わず、型名を直接比べる）。
pub fn is_wayland_display_type_name(name: Option<&str>) -> bool {
    name == Some("GdkWaylandDisplay")
}

/// 表示バックエンドが Wayland かを返す。Linux 以外は常に false。
///
/// 同期コマンド（非 async）は Tauri のメインスレッドで実行されるため GTK を触れる。念のため
/// GTK がこのスレッドで初期化済みでなければ false（判定不能 = 現状維持）を返す。
/// 素の `#[tauri::command]` なので capability 許可は不要。
#[tauri::command]
pub fn is_wayland_session() -> bool {
    detect()
}

#[cfg(target_os = "linux")]
fn detect() -> bool {
    use gtk::gdk;
    use gtk::glib::prelude::ObjectExt;
    if !gtk::is_initialized_main_thread() {
        return false;
    }
    let name = gdk::Display::default().map(|d| d.type_().name().to_string());
    is_wayland_display_type_name(name.as_deref())
}

#[cfg(not(target_os = "linux"))]
fn detect() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wayland_display_is_detected() {
        assert!(is_wayland_display_type_name(Some("GdkWaylandDisplay")));
    }

    #[test]
    fn other_backends_and_unknown_are_not_wayland() {
        for name in [
            "GdkX11Display",
            "GdkBroadwayDisplay",
            "GdkWin32Display",
            "GdkQuartzDisplay",
            "",
        ] {
            assert!(!is_wayland_display_type_name(Some(name)), "{name}");
        }
        assert!(!is_wayland_display_type_name(None));
    }
}
