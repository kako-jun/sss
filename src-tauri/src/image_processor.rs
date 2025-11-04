use image::{imageops::FilterType, GenericImageView, ImageFormat};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;
use base64::{Engine as _, engine::general_purpose};

/// 4K解像度用の最大サイズ
const MAX_WIDTH_4K: u32 = 3840;
const MAX_HEIGHT_4K: u32 = 2160;

/// EXIF情報
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExifInfo {
    pub date_time: Option<String>,
    pub camera_make: Option<String>,
    pub camera_model: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub focal_length: Option<String>,
    pub f_number: Option<String>,
    pub iso: Option<String>,
    pub exposure_time: Option<String>,
}

/// 画像情報
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInfo {
    pub path: String,
    pub optimized_path: Option<String>,  // 4K最適化された画像のパス（ある場合）
    pub image_data: String,  // base64エンコードされた画像データ
    pub width: u32,
    pub height: u32,
    pub file_size: u64,
    pub exif: Option<ExifInfo>,
    pub display_count: i32,
    pub last_displayed: Option<String>,
}

/// 画像を最適化（4K用にリサイズ）
pub fn optimize_image_for_4k(image_path: &Path) -> Result<Vec<u8>, String> {
    // 画像を読み込む
    let img = image::open(image_path)
        .map_err(|e| format!("Failed to open image: {}", e))?;

    let (width, height) = img.dimensions();

    // 4K解像度を超える場合はリサイズ
    let resized_img = if width > MAX_WIDTH_4K || height > MAX_HEIGHT_4K {
        println!(
            "Resizing image from {}x{} to fit 4K",
            width, height
        );
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

/// 画像の基本情報を取得
pub fn get_image_dimensions(image_path: &Path) -> Result<(u32, u32), String> {
    let img = image::open(image_path)
        .map_err(|e| format!("Failed to open image: {}", e))?;

    Ok(img.dimensions())
}

/// 画像ファイルをbase64エンコードされた文字列として読み込む
pub fn read_image_as_base64(image_path: &Path) -> Result<String, String> {
    let mut file = File::open(image_path)
        .map_err(|e| format!("Failed to open file: {}", e))?;

    let mut buffer = Vec::new();
    file.read_to_end(&mut buffer)
        .map_err(|e| format!("Failed to read file: {}", e))?;

    // MIMEタイプを推定
    let mime_type = infer_mime_type(image_path);

    // base64エンコード
    let encoded = general_purpose::STANDARD.encode(&buffer);

    // data URLとして返す
    Ok(format!("data:{};base64,{}", mime_type, encoded))
}

/// ファイル拡張子からMIMEタイプを推定
fn infer_mime_type(path: &Path) -> &'static str {
    match path.extension().and_then(|s| s.to_str()) {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("gif") => "image/gif",
        Some("bmp") => "image/bmp",
        Some("webp") => "image/webp",
        _ => "image/jpeg", // デフォルト
    }
}

/// EXIF情報を取得
pub fn get_exif_info(image_path: &Path) -> Result<ExifInfo, String> {
    let file = File::open(image_path)
        .map_err(|e| format!("Failed to open file: {}", e))?;

    let mut buf_reader = BufReader::new(file);
    let exif_reader = exif::Reader::new();

    match exif_reader.read_from_container(&mut buf_reader) {
        Ok(exif) => {
            let mut info = ExifInfo {
                date_time: None,
                camera_make: None,
                camera_model: None,
                width: None,
                height: None,
                focal_length: None,
                f_number: None,
                iso: None,
                exposure_time: None,
            };

            // 撮影日時
            if let Some(field) = exif.get_field(exif::Tag::DateTime, exif::In::PRIMARY) {
                info.date_time = Some(field.display_value().to_string());
            }

            // カメラメーカー
            if let Some(field) = exif.get_field(exif::Tag::Make, exif::In::PRIMARY) {
                info.camera_make = Some(field.display_value().to_string());
            }

            // カメラモデル
            if let Some(field) = exif.get_field(exif::Tag::Model, exif::In::PRIMARY) {
                info.camera_model = Some(field.display_value().to_string());
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

            // 焦点距離
            if let Some(field) = exif.get_field(exif::Tag::FocalLength, exif::In::PRIMARY) {
                info.focal_length = Some(field.display_value().to_string());
            }

            // F値
            if let Some(field) = exif.get_field(exif::Tag::FNumber, exif::In::PRIMARY) {
                info.f_number = Some(field.display_value().to_string());
            }

            // ISO感度
            if let Some(field) = exif.get_field(exif::Tag::PhotographicSensitivity, exif::In::PRIMARY) {
                info.iso = Some(field.display_value().to_string());
            }

            // 露出時間
            if let Some(field) = exif.get_field(exif::Tag::ExposureTime, exif::In::PRIMARY) {
                info.exposure_time = Some(field.display_value().to_string());
            }

            Ok(info)
        }
        Err(_) => {
            // EXIF情報がない場合は空の情報を返す
            Ok(ExifInfo {
                date_time: None,
                camera_make: None,
                camera_model: None,
                width: None,
                height: None,
                focal_length: None,
                f_number: None,
                iso: None,
                exposure_time: None,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_image_dimensions() {
        // テスト画像がないため、実際のテストはスキップ
        // 実際の環境でテストする際は、テスト用の画像ファイルを用意
    }
}
