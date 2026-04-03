use rand::seq::SliceRandom;
use rand::thread_rng;

/// プレイリスト管理
#[derive(Debug, Clone)]
pub struct Playlist {
    /// シャッフルされた画像リスト
    shuffled_list: Vec<String>,
    /// 現在の位置
    current_index: usize,
    /// 閲覧履歴（最大100件）
    history: Vec<usize>,
    /// 履歴内の現在位置
    history_position: usize,
}

impl Playlist {
    /// 新しいプレイリストを作成（シャッフルあり）
    pub fn new(mut images: Vec<String>) -> Self {
        let mut rng = thread_rng();
        images.shuffle(&mut rng);

        Playlist {
            shuffled_list: images,
            current_index: 0,
            history: vec![0],
            history_position: 0,
        }
    }

    /// 現在の画像を取得
    pub fn current(&self) -> Option<&String> {
        self.shuffled_list.get(self.current_index)
    }

    /// N個先の画像のパスを覗く（インデックスは変更しない）
    pub fn peek_next_n(&self, n: usize) -> Option<&String> {
        if self.shuffled_list.is_empty() {
            return None;
        }
        let next_index = (self.current_index + n) % self.shuffled_list.len();
        self.shuffled_list.get(next_index)
    }

    /// 次の画像に進む（新しい画像、カウント+1）
    /// 戻り値: (画像パス, カウントすべきか)
    pub fn advance(&mut self) -> (Option<&String>, bool) {
        if self.shuffled_list.is_empty() {
            return (None, false);
        }

        // 履歴の途中にいるかチェック（前へで戻った後か？）
        let is_in_history = self.history_position < self.history.len() - 1;

        if is_in_history {
            // 履歴内を進む（既に見た画像なのでカウントしない）
            self.history_position += 1;
            self.current_index = self.history[self.history_position];
            return (self.current(), false);
        }

        // 新しい画像に進む（カウントする）
        // 次のインデックスに進む
        self.current_index = (self.current_index + 1) % self.shuffled_list.len();

        // リストの最後まで到達したら再シャッフル（先頭が直前の末尾と同じにならないよう保証）
        if self.current_index == 0 && self.shuffled_list.len() > 1 {
            // シャッフル前に末尾の画像を記録（直前に表示した画像）
            let last_image = self.shuffled_list.last().cloned();
            let mut rng = thread_rng();
            self.shuffled_list.shuffle(&mut rng);
            // 先頭が直前の画像と同じなら2番目と入れ替えて連続表示を防ぐ
            if let Some(ref last) = last_image {
                if self.shuffled_list.first() == Some(last) {
                    self.shuffled_list.swap(0, 1);
                }
            }
        }

        // 履歴に追加（最大100件）
        if self.history.len() >= 100 {
            self.history.remove(0);
        }
        self.history.push(self.current_index);
        self.history_position = self.history.len() - 1;

        (self.current(), true)
    }

    /// 前の画像に戻る（履歴から、カウント増やさない）
    pub fn go_back(&mut self) -> Option<&String> {
        if self.history_position == 0 {
            // 履歴の最初なので戻れない
            return self.current();
        }

        // 履歴の位置を1つ戻す
        self.history_position -= 1;
        self.current_index = self.history[self.history_position];

        self.current()
    }

    /// 履歴で前に戻れるかチェック
    pub fn can_go_back(&self) -> bool {
        self.history_position > 0
    }

    /// プレイリストの総数を取得
    pub fn total_count(&self) -> usize {
        self.shuffled_list.len()
    }

    /// 現在の位置を取得（1-indexed）
    pub fn current_position(&self) -> usize {
        if self.shuffled_list.is_empty() {
            0
        } else {
            self.current_index + 1
        }
    }

    /// 画像リストを更新（新規画像追加、削除画像除外）
    pub fn update_images(&mut self, new_images: Vec<String>, deleted_images: Vec<String>) {
        // 削除された画像を除外
        if !deleted_images.is_empty() {
            self.shuffled_list
                .retain(|path| !deleted_images.contains(path));
        }

        // 新規画像を追加してシャッフル
        if !new_images.is_empty() {
            let mut rng = thread_rng();

            // 新規画像をシャッフル
            let mut new_shuffled = new_images;
            new_shuffled.shuffle(&mut rng);

            // プレイリストに追加
            self.shuffled_list.extend(new_shuffled);
        }

        // 現在のインデックスが範囲外になった場合は調整
        if self.current_index >= self.shuffled_list.len() && !self.shuffled_list.is_empty() {
            self.current_index = self.shuffled_list.len() - 1;
        }

        // 履歴をクリア（リストが変更されたため）
        self.history = vec![self.current_index];
        self.history_position = 0;
    }

    /// プレイリストが空かチェック
    pub fn is_empty(&self) -> bool {
        self.shuffled_list.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_playlist_basic() {
        let images = vec![
            "img1.jpg".to_string(),
            "img2.jpg".to_string(),
            "img3.jpg".to_string(),
        ];

        let mut playlist = Playlist::new(images.clone());

        // 最初の画像を取得
        assert!(playlist.current().is_some());
        assert_eq!(playlist.total_count(), 3);
        assert_eq!(playlist.current_position(), 1);

        // 次に進む
        let (img, should_count) = playlist.advance();
        assert!(img.is_some());
        assert!(should_count); // 新しい画像なのでカウントする
        assert_eq!(playlist.current_position(), 2);

        // さらに次に進む
        let (img, should_count) = playlist.advance();
        assert!(img.is_some());
        assert!(should_count);
        assert_eq!(playlist.current_position(), 3);

        // 最後まで進んだら最初に戻る（シャッフル）
        let (img, should_count) = playlist.advance();
        assert!(img.is_some());
        assert!(should_count);
        assert_eq!(playlist.current_position(), 1);
    }

    #[test]
    fn test_playlist_history() {
        let images = vec![
            "img1.jpg".to_string(),
            "img2.jpg".to_string(),
            "img3.jpg".to_string(),
        ];

        let mut playlist = Playlist::new(images);

        // 履歴の最初なので戻れない
        assert!(!playlist.can_go_back());

        // 2回進む
        let (_, should_count1) = playlist.advance();
        let (_, should_count2) = playlist.advance();
        assert!(should_count1);
        assert!(should_count2);

        // 履歴があるので戻れる
        assert!(playlist.can_go_back());

        // 1つ戻る
        playlist.go_back();
        assert!(playlist.can_go_back());

        // 再度次へ進む（履歴内なのでカウントしない）
        let (_, should_count) = playlist.advance();
        assert!(!should_count); // 履歴内の画像なのでカウントしない

        // もう1つ戻る
        playlist.go_back();
        assert!(playlist.can_go_back());
    }

    #[test]
    fn test_playlist_update() {
        let images = vec!["img1.jpg".to_string(), "img2.jpg".to_string()];

        let mut playlist = Playlist::new(images);
        assert_eq!(playlist.total_count(), 2);

        // 新規画像を追加
        playlist.update_images(vec!["img3.jpg".to_string()], vec![]);
        assert_eq!(playlist.total_count(), 3);

        // 画像を削除
        playlist.update_images(vec![], vec!["img2.jpg".to_string()]);
        assert_eq!(playlist.total_count(), 2);
    }
}
