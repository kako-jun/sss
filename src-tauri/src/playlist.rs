use rand::seq::SliceRandom;
use rand::thread_rng;
use rand::Rng;
use std::collections::HashSet;

/// 履歴に保持する最大件数（#62: 永続化時に書き出すサイズにも直結するため、
/// 挙動が分かるよう定数として明示する）。
pub const HISTORY_LIMIT: usize = 100;

/// プレイリスト管理
///
/// #62: 履歴は「表示した画像のパス」で保持する（インデックスではない）。
/// 末尾到達時の再シャッフルで `shuffled_list` の並びが丸ごと変わるため、
/// インデックス保持だと再シャッフル境界をまたいで「前へ」戻った際に
/// 別の画像を指してしまう（#62 の元バグ）。パス保持ならシャッフル後も
/// 常に「実際に表示した画像」を指し続ける。
///
/// `current_index` は「`shuffled_list` を順番に消費していく進行カーソル」であり、
/// 履歴を戻って（`go_back`）から再度進める（`advance`）だけの間は変化しない。
/// 新しい画像へ進むとき（履歴の先頭に追いついた状態からの前進）だけ更新される。
#[derive(Debug, Clone)]
pub struct Playlist {
    /// シャッフルされた画像リスト
    shuffled_list: Vec<String>,
    /// 進行カーソル（新規に進んだ最後の shuffled_list 上の位置）
    current_index: usize,
    /// 閲覧履歴（パスで保持、最大 `HISTORY_LIMIT` 件）
    history: Vec<String>,
    /// 履歴内の現在の表示位置
    history_position: usize,
    /// 番兵: true の間はまだ一度も `advance` していない（#62: 最初の `advance` が
    /// index 0 を飛ばして index 1 を返してしまうバグの修正。`current_index` を
    /// 「開始位置の一つ手前」として扱う代わりに、この明示フラグで判定する）。
    before_start: bool,
}

impl Playlist {
    /// 新しいプレイリストを作成（シャッフルあり、まだ何も表示していない状態）
    pub fn new(mut images: Vec<String>) -> Self {
        let mut rng = thread_rng();
        images.shuffle(&mut rng);

        Playlist {
            shuffled_list: images,
            current_index: 0,
            history: Vec::new(),
            history_position: 0,
            before_start: true,
        }
    }

    /// 永続化された状態から復元する（#62）。呼び出し元（DB）が返す値をそのまま渡してよい。
    /// 範囲外の `current_index`/`history_position` は安全な値へクランプする。
    pub fn from_persisted(
        shuffled_list: Vec<String>,
        current_index: usize,
        history: Vec<String>,
        history_position: usize,
    ) -> Self {
        let len = shuffled_list.len();
        let current_index = if len == 0 {
            0
        } else {
            current_index.min(len - 1)
        };
        let history_position = if history.is_empty() {
            0
        } else {
            history_position.min(history.len() - 1)
        };
        let before_start = len == 0 || history.is_empty();

        Playlist {
            shuffled_list,
            current_index,
            history,
            history_position,
            before_start,
        }
    }

    /// 現在の画像を取得（履歴の現在位置から。まだ何も表示していなければ `None`）
    pub fn current(&self) -> Option<&String> {
        if self.before_start {
            return None;
        }
        self.history.get(self.history_position)
    }

    /// N個先の画像のパスを覗く（インデックスは変更しない）。
    ///
    /// #62: 巡の末尾を越える覗き見は行わない（打ち切り）。次の巡の並びは
    /// 実際に `advance` が末尾へ到達するまで確定しないため、ここで先読みすると
    /// 実際の次巡の並びと食い違う（あるいは境界の連続回避チェックより先に
    /// 覗き見してしまう）おそれがある。5枚先読みキャッシュのための用途なので、
    /// 巡の残りが5枚未満なら先読みが減るだけで実害はない（詳細は docs 参照）。
    pub fn peek_next_n(&self, n: usize) -> Option<&String> {
        if self.shuffled_list.is_empty() {
            return None;
        }
        let idx = self.current_index + n;
        if idx >= self.shuffled_list.len() {
            return None;
        }
        self.shuffled_list.get(idx)
    }

    /// 次の画像に進む（新しい画像、カウント+1）
    /// 戻り値: (画像パス, カウントすべきか, このadvanceで再シャッフルが起きたか)
    ///
    /// 3つ目の戻り値は永続化のため（#62）: 再シャッフルが起きた場合は
    /// `shuffled_list` 自体が変わるためフル保存が必要、それ以外は
    /// `current_index`/履歴だけの軽量保存で足りる。
    pub fn advance(&mut self) -> (Option<&String>, bool, bool) {
        if self.shuffled_list.is_empty() {
            return (None, false, false);
        }

        if self.before_start {
            // 番兵: 最初の advance で index 0 を返す（#62）。
            self.before_start = false;
            self.current_index = 0;
            self.history = vec![self.shuffled_list[0].clone()];
            self.history_position = 0;
            return (self.current(), true, false);
        }

        // 履歴の途中にいるかチェック（前へで戻った後か？）
        let is_in_history = self.history_position < self.history.len() - 1;

        if is_in_history {
            // 履歴内を進む（既に見た画像なのでカウントしない）
            self.history_position += 1;
            return (self.current(), false, false);
        }

        // 新しい画像に進む（カウントする）
        self.current_index = (self.current_index + 1) % self.shuffled_list.len();

        let mut reshuffled = false;

        // リストの最後まで到達したら再シャッフル（先頭が直前の表示画像と同じにならないよう保証）
        if self.current_index == 0 && self.shuffled_list.len() > 1 {
            // シャッフル前に「実際に最後に表示した画像」を記録する。
            // #62: history はパスで保持しているので、直前の shuffled_list の並びに
            // 依存せず正しい「直前の画像」を取れる。
            let last_shown = self.history.last().cloned();
            let mut rng = thread_rng();
            self.shuffled_list.shuffle(&mut rng);
            reshuffled = true;
            // 先頭が直前の画像と同じなら2番目と入れ替えて連続表示を防ぐ
            if let Some(ref last) = last_shown {
                if self.shuffled_list.first() == Some(last) {
                    self.shuffled_list.swap(0, 1);
                }
            }
        }

        // 履歴に追加（最大 HISTORY_LIMIT 件）
        if self.history.len() >= HISTORY_LIMIT {
            self.history.remove(0);
        }
        self.history
            .push(self.shuffled_list[self.current_index].clone());
        self.history_position = self.history.len() - 1;

        (self.current(), true, reshuffled)
    }

    /// 前の画像に戻る（履歴から、カウント増やさない）。
    ///
    /// #62: `current_index`（進行カーソル）は変更しない。戻った先から再度
    /// 前進する場合に、正しい続きの位置から再開できるようにするため。
    pub fn go_back(&mut self) -> Option<&String> {
        if self.before_start || self.history_position == 0 {
            // 履歴の最初なので戻れない
            return self.current();
        }

        self.history_position -= 1;
        self.current()
    }

    /// 履歴で前に戻れるかチェック
    pub fn can_go_back(&self) -> bool {
        !self.before_start && self.history_position > 0
    }

    /// プレイリストの総数を取得
    pub fn total_count(&self) -> usize {
        self.shuffled_list.len()
    }

    /// 現在の位置を取得（1-indexed）。
    ///
    /// 履歴を戻って閲覧中の画像が現在の `shuffled_list` の並びの中にまだ
    /// 存在すれば、その実際の位置を返す（同一巡内での「前へ」なら常に見つかる）。
    /// 再シャッフル後で見つからない場合は進行カーソルの位置にフォールバックする。
    pub fn current_position(&self) -> usize {
        if self.shuffled_list.is_empty() || self.before_start {
            return 0;
        }
        if let Some(path) = self.history.get(self.history_position) {
            if let Some(idx) = self.shuffled_list.iter().position(|p| p == path) {
                return idx + 1;
            }
        }
        self.current_index + 1
    }

    /// 画像リストを更新（新規画像追加、削除画像除外）
    ///
    /// #61レビュー M-B(must): `deleted_images` を `Vec` のまま `retain` の中で
    /// `Vec::contains` していたため O(N×M)（N=プレイリスト全体、M=削除件数）になり、
    /// 10万件規模・削除5万件で数秒かかる退行があった。`HashSet` に変換してから判定する
    /// ことで `retain` 全体を O(N) に落とす。
    ///
    /// #62:
    /// - 削除は `current_index` より前（=既に表示済みの区間）にあった件数だけ
    ///   `current_index` を減算する。そうしないと、削除された分だけ未表示の画像を
    ///   飛ばしてしまう。
    /// - 削除された画像は履歴からも取り除く（表示中の画像が生き残っていれば
    ///   その新しい位置へ `history_position` を再計算する）。
    /// - 新規画像は「未再生区間」（`current_index` より後ろ。何も表示していなければ
    ///   全体）にランダムに散らして挿入する。末尾へ塊で追加すると、その巡の終盤に
    ///   新規画像が連続して固まって出てしまうため。挿入は既存の未再生区間の順序を
    ///   保ったまま新規画像をランダムな位置へ差し込む1パスのマージ（O(N+K)）で行う
    ///   （`Vec::insert` を新規件数分繰り返すと O(N×K) になり10万件規模で遅い）。
    pub fn update_images(&mut self, new_images: Vec<String>, deleted_images: Vec<String>) {
        if !deleted_images.is_empty() {
            let deleted_set: HashSet<&str> = deleted_images.iter().map(String::as_str).collect();

            let boundary = self.current_index.min(self.shuffled_list.len());
            let removed_before_current = self.shuffled_list[..boundary]
                .iter()
                .filter(|p| deleted_set.contains(p.as_str()))
                .count();

            self.shuffled_list
                .retain(|path| !deleted_set.contains(path.as_str()));
            self.current_index = self.current_index.saturating_sub(removed_before_current);

            // 履歴からも削除された画像を除去し、表示中位置を再計算する。
            let current_path = self.history.get(self.history_position).cloned();
            self.history.retain(|p| !deleted_set.contains(p.as_str()));
            self.history_position = current_path
                .as_ref()
                .and_then(|p| self.history.iter().position(|x| x == p))
                .unwrap_or_else(|| self.history.len().saturating_sub(1));
        }

        if !new_images.is_empty() {
            let mut rng = thread_rng();
            let mut new_shuffled = new_images;
            new_shuffled.shuffle(&mut rng);

            // 未再生区間の開始位置。まだ一度も表示していなければ全体が未再生区間。
            let split_at = if self.before_start {
                0
            } else {
                (self.current_index + 1).min(self.shuffled_list.len())
            };
            let suffix = self.shuffled_list.split_off(split_at);

            // 既存の未再生区間（suffix、既にランダム順）と新規画像（new_shuffled、
            // ランダム順）を、それぞれの相対順序を保ったまま件数比でランダムに
            // インターリーブする。O(N+K) で新規画像が偏りなく散らばる。
            let mut suffix_iter = suffix.into_iter().peekable();
            let mut new_iter = new_shuffled.into_iter().peekable();
            let mut merged = Vec::with_capacity(suffix_iter.len() + new_iter.len());
            while suffix_iter.peek().is_some() || new_iter.peek().is_some() {
                let remaining_s = suffix_iter.len();
                let remaining_n = new_iter.len();
                let take_suffix = remaining_n == 0
                    || (remaining_s > 0
                        && rng.gen_range(0..(remaining_s + remaining_n)) < remaining_s);
                if take_suffix {
                    merged.push(suffix_iter.next().unwrap());
                } else {
                    merged.push(new_iter.next().unwrap());
                }
            }
            self.shuffled_list.extend(merged);
        }

        // 現在のインデックスが範囲外になった場合は調整
        if self.current_index >= self.shuffled_list.len() && !self.shuffled_list.is_empty() {
            self.current_index = self.shuffled_list.len() - 1;
        }

        // 削除により履歴が空になってしまった場合の安全策（まだ開始前なら空のままでよい）
        if !self.before_start && self.history.is_empty() {
            if let Some(path) = self.shuffled_list.get(self.current_index) {
                self.history = vec![path.clone()];
            }
            self.history_position = 0;
        }

        if self.shuffled_list.is_empty() {
            self.current_index = 0;
            self.history.clear();
            self.history_position = 0;
            self.before_start = true;
        }
    }

    /// プレイリストが空かチェック
    pub fn is_empty(&self) -> bool {
        self.shuffled_list.is_empty()
    }

    /// 現在プレイリストに含まれている全パスの集合を返す（クローン）。
    /// スキャン結果（除外ルール適用後の「含めるべき」集合）との差分を取り、
    /// `update_images` に渡す addded/removed を計算するために使う（#61 レビュー M2）。
    pub fn current_paths(&self) -> std::collections::HashSet<String> {
        self.shuffled_list.iter().cloned().collect()
    }

    /// 永続化用: シャッフル済みリストへの参照（#62）。
    pub fn shuffled_list(&self) -> &[String] {
        &self.shuffled_list
    }

    /// 永続化用: 進行カーソル（#62）。
    pub fn current_index(&self) -> usize {
        self.current_index
    }

    /// 永続化用: 履歴（パス列、#62）。
    pub fn history(&self) -> &[String] {
        &self.history
    }

    /// 永続化用: 履歴内の現在の表示位置（#62）。
    pub fn history_position(&self) -> usize {
        self.history_position
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn test_playlist_basic() {
        let images = vec![
            "img1.jpg".to_string(),
            "img2.jpg".to_string(),
            "img3.jpg".to_string(),
        ];

        let mut playlist = Playlist::new(images.clone());

        // 開始前は current() が None（#62: まだ何も表示していない）
        assert!(playlist.current().is_none());
        assert_eq!(playlist.total_count(), 3);
        assert_eq!(playlist.current_position(), 0);

        // 最初の advance で index 0 が返る（#62: 飛ばされない）
        let (img, should_count, reshuffled) = playlist.advance();
        assert!(img.is_some());
        assert!(should_count);
        assert!(!reshuffled);
        assert_eq!(playlist.current_position(), 1);

        // 次に進む
        let (img, should_count, _) = playlist.advance();
        assert!(img.is_some());
        assert!(should_count);
        assert_eq!(playlist.current_position(), 2);

        // さらに次に進む
        let (img, should_count, _) = playlist.advance();
        assert!(img.is_some());
        assert!(should_count);
        assert_eq!(playlist.current_position(), 3);

        // 最後まで進んだら最初に戻る（シャッフル）
        let (img, should_count, reshuffled) = playlist.advance();
        assert!(img.is_some());
        assert!(should_count);
        assert!(reshuffled);
        assert_eq!(playlist.current_position(), 1);
    }

    /// #62: 最初の `advance()` が index 0 を飛ばさない（旧バグの直接テスト）。
    /// 1件だけのプレイリストで、advance のたびに毎回その1件が返り続ける
    /// （2件目に「進めない」まま同じ画像を繰り返し返す＝先頭を飛ばしていない証拠）。
    #[test]
    fn advance_first_call_returns_index_zero_not_skipped() {
        let mut playlist = Playlist::new(vec!["only.jpg".to_string()]);
        let (img, should_count, _) = playlist.advance();
        assert_eq!(img, Some(&"only.jpg".to_string()));
        assert!(should_count);
    }

    /// #62 平等性: 1巡（total_count回のadvance）で全件がちょうど1回ずつ表示される。
    #[test]
    fn one_full_cycle_visits_every_image_exactly_once() {
        let images: Vec<String> = (0..50).map(|i| format!("img{i}.jpg")).collect();
        let mut playlist = Playlist::new(images.clone());

        let mut seen = Vec::new();
        for _ in 0..playlist.total_count() {
            let (img, should_count, _) = playlist.advance();
            assert!(should_count, "1巡目は全件が新規表示のはず");
            seen.push(img.unwrap().clone());
        }

        let seen_set: HashSet<String> = seen.iter().cloned().collect();
        let expected_set: HashSet<String> = images.into_iter().collect();
        assert_eq!(seen.len(), 50, "重複や欠落なく50件表示されるはず");
        assert_eq!(
            seen_set, expected_set,
            "全件がちょうど1回ずつ表示されるはず"
        );
    }

    /// #62 境界: 巡の最後の画像と次巡の最初の画像が同じにならない。
    #[test]
    fn no_adjacent_duplicate_across_cycle_boundary() {
        let images: Vec<String> = (0..10).map(|i| format!("img{i}.jpg")).collect();
        let mut playlist = Playlist::new(images);

        let mut last_shown: Option<String> = None;
        for _ in 0..5 {
            // 5巡分
            for i in 0..playlist.total_count() {
                let (img, _, _) = playlist.advance();
                let path = img.unwrap().clone();
                if i == 0 {
                    if let Some(ref last) = last_shown {
                        assert_ne!(&path, last, "巡の境界で同じ画像が連続してはいけない");
                    }
                }
                last_shown = Some(path);
            }
        }
    }

    /// #62 復元: 保存(shuffled_list/current_index/history/history_position)→
    /// `from_persisted` で新しい `Playlist` を作っても、続きから再開して
    /// 1巡ぶん全件がちょうど1回ずつ表示される（再起動を跨いだのと同等の状況）。
    #[test]
    fn restart_across_new_playlist_instance_completes_cycle_exactly_once() {
        let images: Vec<String> = (0..20).map(|i| format!("img{i}.jpg")).collect();
        let mut playlist = Playlist::new(images.clone());

        let mut seen = Vec::new();
        // 半分だけ進めてから「保存」する
        for _ in 0..10 {
            let (img, _, _) = playlist.advance();
            seen.push(img.unwrap().clone());
        }

        // 保存された状態を模して新しい Playlist インスタンスを作る（再起動相当）。
        let restored = Playlist::from_persisted(
            playlist.shuffled_list().to_vec(),
            playlist.current_index(),
            playlist.history().to_vec(),
            playlist.history_position(),
        );
        assert_eq!(restored.current_position(), playlist.current_position());
        assert_eq!(restored.total_count(), playlist.total_count());

        let mut playlist = restored;
        // 残り10件を進める
        for _ in 0..10 {
            let (img, should_count, _) = playlist.advance();
            assert!(should_count);
            seen.push(img.unwrap().clone());
        }

        let seen_set: HashSet<String> = seen.iter().cloned().collect();
        let expected_set: HashSet<String> = images.into_iter().collect();
        assert_eq!(seen.len(), 20);
        assert_eq!(
            seen_set, expected_set,
            "再起動を跨いでも1巡で全件ちょうど1回のはず"
        );
    }

    /// #62: 復元直後でも `advance()` の番兵は正しく機能する（0件進めた状態からの
    /// 復元、つまり `before_start` のまま保存されたケース）。
    #[test]
    fn restart_before_any_advance_still_returns_index_zero_first() {
        let playlist = Playlist::new(vec!["a.jpg".to_string(), "b.jpg".to_string()]);
        let restored = Playlist::from_persisted(
            playlist.shuffled_list().to_vec(),
            playlist.current_index(),
            playlist.history().to_vec(),
            playlist.history_position(),
        );
        let mut restored = restored;
        assert!(restored.current().is_none());
        let (img, should_count, _) = restored.advance();
        assert!(img.is_some());
        assert!(should_count);
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

        // 3回進む（#62: 最初のadvanceがindex 0そのものを返すため、旧実装のような
        // 「開始位置」を表す幽霊エントリは無い。3回進めば履歴は3件になる）
        let (_, should_count1, _) = playlist.advance();
        let (_, should_count2, _) = playlist.advance();
        let (_, should_count3, _) = playlist.advance();
        assert!(should_count1);
        assert!(should_count2);
        assert!(should_count3);

        // 履歴があるので戻れる
        assert!(playlist.can_go_back());

        // 1つ戻る（3件中2件目へ）
        playlist.go_back();
        assert!(playlist.can_go_back(), "まだ履歴の先頭ではないので戻れる");

        // 再度次へ進む（履歴内なのでカウントしない）
        let (_, should_count, _) = playlist.advance();
        assert!(!should_count); // 履歴内の画像なのでカウントしない

        // もう1つ戻る（2件目へ）
        playlist.go_back();
        assert!(playlist.can_go_back(), "まだ履歴の先頭ではないので戻れる");

        // 履歴の先頭まで戻る
        playlist.go_back();
        assert!(!playlist.can_go_back(), "履歴の先頭まで戻ったら戻れない");
    }

    /// #62: 履歴はパスで保持するため、再シャッフル境界をまたいで「前へ」戻っても、
    /// 実際に表示した画像そのものが返る（インデックス保持だと別の画像を指してしまう）。
    #[test]
    fn go_back_across_reshuffle_boundary_returns_exact_previously_shown_path() {
        let images: Vec<String> = (0..5).map(|i| format!("img{i}.jpg")).collect();
        let mut playlist = Playlist::new(images);

        // 1巡目をすべて進めて、2巡目の先頭まで到達させる（この中で再シャッフルが起きる）。
        let mut shown = Vec::new();
        let mut reshuffled_at = None;
        for i in 0..playlist.total_count() + 1 {
            let (img, _, reshuffled) = playlist.advance();
            shown.push(img.unwrap().clone());
            if reshuffled {
                reshuffled_at = Some(i);
            }
        }
        assert!(
            reshuffled_at.is_some(),
            "6回目のadvanceで再シャッフルが起きるはず"
        );

        // 直前に表示された画像（2巡目の先頭）から go_back で1つ戻ると、
        // 1巡目最後に実際に表示した画像がそのまま返るはず。
        let expected_previous = shown[shown.len() - 2].clone();
        let got = playlist.go_back().cloned();
        assert_eq!(
            got,
            Some(expected_previous),
            "再シャッフル境界をまたいでも前へは実際に表示した画像を返すはず"
        );
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

    /// #62: 新規画像は「未再生区間」（current_index より後ろ）にのみ挿入される。
    /// 既に表示済みの区間（0..=current_index）に紛れ込んで、今回の巡で
    /// 二度と表示されなくなる/表示済み扱いのまま出てこない、ということがない。
    #[test]
    fn update_images_inserts_new_images_only_into_unplayed_segment() {
        let images: Vec<String> = (0..20).map(|i| format!("img{i}.jpg")).collect();
        let mut playlist = Playlist::new(images);

        // 10件進めておく（current_index = 9 相当のところまで）
        for _ in 0..10 {
            playlist.advance();
        }
        let current_index = playlist.current_index();

        let new_images: Vec<String> = (0..5).map(|i| format!("new{i}.jpg")).collect();
        playlist.update_images(new_images.clone(), vec![]);

        let list = playlist.shuffled_list();
        for path in &new_images {
            let pos = list
                .iter()
                .position(|p| p == path)
                .expect("挿入されているはず");
            assert!(
                pos > current_index,
                "新規画像({path})は未再生区間(current_index={current_index}より後ろ)に入るはず、実際は{pos}"
            );
        }
    }

    /// #62: `update_images` は `current_index` より前で削除された件数だけ
    /// `current_index` を減算し、未再生の画像を飛ばさない。
    #[test]
    fn update_images_shifts_current_index_by_deletions_before_it() {
        let images: Vec<String> = (0..10).map(|i| format!("img{i}.jpg")).collect();
        let mut playlist = Playlist::new(images.clone());

        // 5件進める（current_index = 4）
        for _ in 0..5 {
            playlist.advance();
        }
        assert_eq!(playlist.current_index(), 4);
        let current_path = playlist.shuffled_list()[4].clone();

        // current_index より前(0..=3)にある画像のうち2件を削除する
        let before_current: Vec<String> = playlist.shuffled_list()[0..4].to_vec();
        let deleted: Vec<String> = before_current.into_iter().take(2).collect();
        playlist.update_images(vec![], deleted);

        assert_eq!(
            playlist.current_index(),
            2,
            "current_indexより前の削除2件ぶんだけ減算されるはず"
        );
        // current_index が指す画像自体は変わらない(削除されていないため)
        assert_eq!(
            playlist.shuffled_list()[playlist.current_index()],
            current_path
        );
    }

    /// #62: `current_paths` はプレイリストの現在のメンバーシップを
    /// 過不足なく返す（スキャン結果との差分計算の土台）。
    #[test]
    fn current_paths_reflects_membership_after_updates() {
        let images = vec!["img1.jpg".to_string(), "img2.jpg".to_string()];
        let mut playlist = Playlist::new(images);

        let mut expected: std::collections::HashSet<String> = ["img1.jpg", "img2.jpg"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(playlist.current_paths(), expected);

        playlist.update_images(vec!["img3.jpg".to_string()], vec!["img1.jpg".to_string()]);
        expected.remove("img1.jpg");
        expected.insert("img3.jpg".to_string());
        assert_eq!(playlist.current_paths(), expected);
    }

    /// #62: 巡の末尾を越える `peek_next_n` は打ち切り（`None`）で返す（次巡の並びは
    /// まだ確定していないため、境界をまたいで覗かない）。
    #[test]
    fn peek_next_n_cuts_off_at_cycle_boundary_instead_of_wrapping() {
        let images: Vec<String> = (0..5).map(|i| format!("img{i}.jpg")).collect();
        let mut playlist = Playlist::new(images);

        // 4件目まで進める(current_index=3、残り1件)
        for _ in 0..4 {
            playlist.advance();
        }
        assert!(playlist.peek_next_n(1).is_some(), "残り1件は覗けるはず");
        assert!(
            playlist.peek_next_n(2).is_none(),
            "巡の末尾を越える覗き見は打ち切られるはず(次巡の並びは未確定)"
        );
    }

    /// #61レビュー M-B(must) 規模テスト: 10万件のプレイリストから5万件を削除する
    /// `update_images` が実用的な時間で終わること。修正前の `Vec::contains` ベースの
    /// `retain`（O(N×M)）ではリリースビルドでも約8.6秒かかっていた（レビュー実測）。
    /// `HashSet` 化後は O(N) なので、CIでも安定して速い上限（2秒）を余裕を持って
    /// 下回るはず。
    #[test]
    fn update_images_removes_50k_from_100k_quickly() {
        const TOTAL: usize = 100_000;
        const REMOVE: usize = 50_000;

        let images: Vec<String> = (0..TOTAL).map(|i| format!("img{i}.jpg")).collect();
        let mut playlist = Playlist::new(images);
        assert_eq!(playlist.total_count(), TOTAL);

        // 偶数番号を削除対象にする（全体に散らばらせ、実運用に近い条件にする）
        let deleted: Vec<String> = (0..TOTAL)
            .step_by(2)
            .take(REMOVE)
            .map(|i| format!("img{i}.jpg"))
            .collect();

        let start = std::time::Instant::now();
        playlist.update_images(vec![], deleted);
        let elapsed = start.elapsed();

        assert_eq!(playlist.total_count(), TOTAL - REMOVE);
        assert!(
            elapsed.as_secs_f64() < 2.0,
            "10万件から5万件削除に{:.3}秒かかった（O(N×M)への退行の疑い）",
            elapsed.as_secs_f64()
        );
    }

    /// #61レビュー M-B 計算量確認: `current_paths`（全件クローンしてHashSet化。
    /// O(N)）と、新規追加の挿入（未再生区間へのランダムインターリーブ、O(N+K)）も
    /// 10万件規模で実用的な時間に収まること。
    #[test]
    fn current_paths_and_add_scale_to_100k_quickly() {
        const TOTAL: usize = 100_000;
        let images: Vec<String> = (0..TOTAL).map(|i| format!("img{i}.jpg")).collect();
        let mut playlist = Playlist::new(images);

        let start = std::time::Instant::now();
        let paths = playlist.current_paths();
        let current_paths_elapsed = start.elapsed();
        assert_eq!(paths.len(), TOTAL);
        assert!(
            current_paths_elapsed.as_secs_f64() < 1.0,
            "current_paths（10万件）に{:.3}秒かかった",
            current_paths_elapsed.as_secs_f64()
        );

        let added: Vec<String> = (TOTAL..TOTAL + 10_000)
            .map(|i| format!("img{i}.jpg"))
            .collect();
        let start = std::time::Instant::now();
        playlist.update_images(added, vec![]);
        let add_elapsed = start.elapsed();
        assert_eq!(playlist.total_count(), TOTAL + 10_000);
        assert!(
            add_elapsed.as_secs_f64() < 1.0,
            "1万件追加に{:.3}秒かかった",
            add_elapsed.as_secs_f64()
        );
    }
}
