// サブモジュール宣言
pub mod types;
pub mod scan;
pub mod image;
pub mod file_operations;
pub mod stats;
pub mod settings;
pub mod system;

// 公開型の再エクスポート
pub use types::{AppState, ScanProgress, Stats};

// コマンドの再エクスポート
pub use scan::{scan_folder, init_playlist};
pub use image::{get_next_image, get_previous_image};
pub use file_operations::{open_in_explorer, share_image, exclude_image};
pub use stats::{get_stats, get_playlist_info, get_display_stats};
pub use settings::{save_setting, get_setting, get_last_folder_path};
pub use system::exit_app;
