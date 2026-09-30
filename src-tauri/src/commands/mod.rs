// サブモジュール宣言
pub mod dialog;
pub mod file_operations;
pub mod image;
pub mod playlist_persistence;
pub mod scan;
pub mod settings;
pub mod stats;
pub mod system;
pub mod types;

// 公開型の再エクスポート
pub use types::AppState;
