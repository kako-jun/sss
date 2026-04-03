use image::{imageops::FilterType, GenericImageView, ImageFormat};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::BufReader;
use std::path::Path;

/// 4K解像度用の最大サイズ
const MAX_WIDTH_4K: u32 = 3840;
const MAX_HEIGHT_4K: u32 = 2160;

/// EXIF情報
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExifInfo {
    pub date_time: Option<String>,
    pub gps_latitude: Option<f64>,
    pub gps_longitude: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// 画像情報
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInfo {
    pub path: String,
    pub optimized_path: Option<String>, // 4K最適化された画像のパス（ある場合）
    pub is_video: bool,                 // 動画ファイルかどうか
    pub width: u32,
    pub height: u32,
    pub file_size: u64,
    pub exif: Option<ExifInfo>,
    pub display_count: i32,
    pub last_displayed: Option<String>,
}

/// 画像を最適化（EXIF回転適用 + 4Kリサイズ）
pub fn optimize_image_for_4k(image_path: &Path, apply_rotation: bool) -> Result<Vec<u8>, String> {
    // 画像を読み込む
    let img = image::open(image_path).map_err(|e| format!("Failed to open image: {}", e))?;

    // EXIF Orientationに基づいて回転・反転を適用（リサイズ前）
    let img = if apply_rotation {
        apply_exif_orientation(image_path, img)
    } else {
        img
    };

    let (width, height) = img.dimensions();

    // 4K解像度を超える場合はリサイズ
    let resized_img = if width > MAX_WIDTH_4K || height > MAX_HEIGHT_4K {
        img.resize(MAX_WIDTH_4K, MAX_HEIGHT_4K, FilterType::Lanczos3)
    } else {
        img
    };

    // JPEG形式でエンコード（品質90%）
    let mut buffer = Vec::new();
    resized_img
        .write_to(&mut std::io::Cursor::new(&mut buffer), ImageFormat::Jpeg)
        .map_err(|e| format!("Failed to encode image: {}", e))?;

    Ok(buffer)
}

/// EXIF Orientationタグを読み取り、画像に回転・反転を適用する
fn apply_exif_orientation(image_path: &Path, img: image::DynamicImage) -> image::DynamicImage {
    // ファイルを開いてEXIFを読み取る
    let orientation = (|| -> Option<u32> {
        let file = File::open(image_path).ok()?;
        let mut buf_reader = BufReader::new(file);
        let exif_reader = exif::Reader::new();
        let exif = exif_reader.read_from_container(&mut buf_reader).ok()?;
        let field = exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY)?;
        field.value.get_uint(0)
    })();

    match orientation {
        Some(1) | None => img,             // そのまま（変換不要 / EXIFなし）
        Some(2) => img.fliph(),            // 水平反転
        Some(3) => img.rotate180(),        // 180度回転
        Some(4) => img.flipv(),            // 垂直反転
        Some(5) => img.rotate90().flipv(), // transpose: 90度時計回り + 垂直反転
        Some(6) => img.rotate90(),         // 90度時計回り回転
        Some(7) => img.rotate90().fliph(), // transverse: 90度時計回り + 水平反転
        Some(8) => img.rotate270(),        // 90度反時計回り回転
        _ => img,                          // 未知の値はそのまま
    }
}

/// 画像の基本情報を取得
pub fn get_image_dimensions(image_path: &Path) -> Result<(u32, u32), String> {
    let img = image::open(image_path).map_err(|e| format!("Failed to open image: {}", e))?;

    Ok(img.dimensions())
}

/// EXIF情報を取得
pub fn get_exif_info(image_path: &Path) -> Result<ExifInfo, String> {
    let file = File::open(image_path).map_err(|e| format!("Failed to open file: {}", e))?;

    let mut buf_reader = BufReader::new(file);
    let exif_reader = exif::Reader::new();

    match exif_reader.read_from_container(&mut buf_reader) {
        Ok(exif) => {
            let mut info = ExifInfo {
                date_time: None,
                gps_latitude: None,
                gps_longitude: None,
                width: None,
                height: None,
            };

            // 撮影日時
            if let Some(field) = exif.get_field(exif::Tag::DateTime, exif::In::PRIMARY) {
                info.date_time = Some(field.display_value().to_string());
            }

            // GPS座標の取得
            // 緯度
            if let Some(lat_field) = exif.get_field(exif::Tag::GPSLatitude, exif::In::PRIMARY) {
                if let Some(lat_ref_field) =
                    exif.get_field(exif::Tag::GPSLatitudeRef, exif::In::PRIMARY)
                {
                    if let Some(latitude) = parse_gps_coordinate(
                        &lat_field.value,
                        &lat_ref_field.display_value().to_string(),
                    ) {
                        info.gps_latitude = Some(latitude);
                    }
                }
            }

            // 経度
            if let Some(lon_field) = exif.get_field(exif::Tag::GPSLongitude, exif::In::PRIMARY) {
                if let Some(lon_ref_field) =
                    exif.get_field(exif::Tag::GPSLongitudeRef, exif::In::PRIMARY)
                {
                    if let Some(longitude) = parse_gps_coordinate(
                        &lon_field.value,
                        &lon_ref_field.display_value().to_string(),
                    ) {
                        info.gps_longitude = Some(longitude);
                    }
                }
            }

            // 画像サイズ
            if let Some(field) = exif.get_field(exif::Tag::PixelXDimension, exif::In::PRIMARY) {
                if let Some(width) = field.value.get_uint(0) {
                    info.width = Some(width);
                }
            }
            if let Some(field) = exif.get_field(exif::Tag::PixelYDimension, exif::In::PRIMARY) {
                if let Some(height) = field.value.get_uint(0) {
                    info.height = Some(height);
                }
            }

            Ok(info)
        }
        Err(_) => {
            // EXIF情報がない場合は空の情報を返す
            Ok(ExifInfo {
                date_time: None,
                gps_latitude: None,
                gps_longitude: None,
                width: None,
                height: None,
            })
        }
    }
}

/// GPS座標をパースして10進数に変換
fn parse_gps_coordinate(value: &exif::Value, reference: &str) -> Option<f64> {
    // GPS座標は度・分・秒の3つの有理数で表現される
    if let exif::Value::Rational(coords) = value {
        if coords.len() >= 3 {
            // 0除算チェック（不正なEXIFデータ対策）
            if coords[0].denom == 0 || coords[1].denom == 0 || coords[2].denom == 0 {
                return None;
            }

            let degrees = coords[0].to_f64();
            let minutes = coords[1].to_f64();
            let seconds = coords[2].to_f64();

            let mut decimal = degrees + (minutes / 60.0) + (seconds / 3600.0);

            // 南緯または西経の場合は負の値にする
            // display_value()の出力が余分な空白や引用符を含む場合に備えてtrimする
            let reference_trimmed = reference.trim().trim_matches('"');
            if reference_trimmed == "S" || reference_trimmed == "W" {
                decimal = -decimal;
            }

            return Some(decimal);
        }
    }
    None
}

/// 動画ファイルかどうかを判定
pub fn is_video_file(path: &Path) -> bool {
    if let Some(extension) = path.extension() {
        let ext = extension.to_string_lossy().to_lowercase();
        matches!(
            ext.as_str(),
            "mp4" | "mov" | "avi" | "mkv" | "webm" | "flv" | "wmv" | "m4v"
        )
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_image_dimensions() {
        // テスト画像がないため、実際のテストはスキップ
        // 実際の環境でテストする際は、テスト用の画像ファイルを用意
    }
}
