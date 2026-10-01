#!/bin/sh
# 並行 worktree で pre-commit(lint-staged) を同時に走らせても stash が汚れずコミットが全て成功するかを検証する (#126)
#
# 使い方:
#   scripts/verify-concurrent-precommit.sh                 # 現行の .husky/pre-commit を検証 (回帰ガード)
#   scripts/verify-concurrent-precommit.sh --legacy        # --no-stash を外した旧挙動を再現
#   scripts/verify-concurrent-precommit.sh --check-harness # --legacy で失敗が再現することを確認してから既定モードを実行
#   COMMITS=20 scripts/verify-concurrent-precommit.sh      # 1 worktree あたりのコミット回数 (既定 20)
#
# 結果の読み方:
#   - 既定モード (--no-stash) は構造上 stash が 0 件になるので「測定結果」ではなく回帰ガード。
#     harness が本当に失敗を再現できるかの証拠は --legacy 側。
#   - --legacy は失敗 (stash 衝突) を再現するのが正しい動作で、再現すれば exit 1 になる (仕様)。
#     --legacy で exit 0 なら harness が壊れているか、競合が今回のタイミングで起きなかっただけ (再実行する)。
#   - --check-harness は --legacy が再現しなければ警告して exit 3、再現すれば既定モードの結果 (exit 0 = 成功) を返す。
#   - 既定モードの終了コード 0 = 全コミット成功かつ stash 0 件。
#
# 実リポジトリの stash / worktree には一切触らず、使い捨ての一時リポジトリ内だけで動く。
# 一時領域は $E2E_TMP_BASE (既定 $HOME/.cache/e2etmp) 配下。
#
# 注: バックグラウンドジョブの失敗を許容して集計するため set -e は使わない。
#     #!/bin/sh は dash の環境があり pipefail が使えないので採用しない (パイプの失敗は個別に判定する)。
set -u

if [ "${1:-}" = "--check-harness" ]; then
  self="$0"
  echo "== harness check: --legacy (失敗の再現を期待) =="
  "$self" --legacy
  if [ "$?" -eq 0 ]; then
    echo "WARNING: --legacy でも失敗が再現しなかった。harness が壊れているか競合が起きなかった (再実行して確認)" >&2
    exit 3
  fi
  echo "== harness check OK (legacy で再現)。既定モードを実行 =="
  exec "$self"
fi

LEGACY=0
[ "${1:-}" = "--legacy" ] && LEGACY=1
COMMITS="${COMMITS:-20}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${E2E_TMP_BASE:-$HOME/.cache/e2etmp}"
case "$BASE" in ""|/) echo "invalid E2E_TMP_BASE: '$BASE'" >&2; exit 2;; esac
mkdir -p "$BASE"
T="$(mktemp -d "$BASE/precommit-XXXXXX")"
case "$T" in "$BASE"/precommit-*) ;; *) echo "unexpected temp dir: $T" >&2; exit 2;; esac
trap 'rm -rf "$T"' EXIT

HOOK="$T/pre-commit-body"
if [ "$LEGACY" = 1 ]; then
  sed 's/ --no-stash//' "$ROOT/.husky/pre-commit" > "$HOOK"
else
  cp "$ROOT/.husky/pre-commit" "$HOOK"
fi
echo "hook:"; sed 's/^/  /' "$HOOK"

R="$T/repo"
git init -q -b main "$R"
cd "$R" || exit 2
git config user.email t@example.com
git config user.name t
ln -s "$ROOT/node_modules" node_modules
for f in package.json eslint.config.js tsconfig.json .prettierrc; do
  [ -f "$ROOT/$f" ] || { echo "missing config: $ROOT/$f" >&2; exit 2; }
  cp "$ROOT/$f" .
done
mkdir -p src src-tauri/src
printf '[package]\nname = "t"\nversion = "0.0.0"\nedition = "2021"\n\n[workspace]\n' > src-tauri/Cargo.toml
echo 'fn main() {}' > src-tauri/src/main.rs
printf 'node_modules\n' > .gitignore
echo 'export const a = 1;' > src/base.ts
echo 'export const u = 0;' > src/unstaged_wtA.ts
echo 'export const u = 0;' > src/unstaged_wtB.ts
git add -A && git commit -q -m init --no-verify
echo "$HOOK" > "$T/hookpath"

# 本物の pre-commit を sh -e で実行する薄い hook
mkdir -p "$T/hooks"
printf '#!/bin/sh\nset -e\nexport PATH="%s/node_modules/.bin:$PATH"\nsh -e "%s"\n' "$ROOT" "$HOOK" > "$T/hooks/pre-commit"
chmod +x "$T/hooks/pre-commit"
git config core.hooksPath "$T/hooks"

git worktree add -q -b wtA "$T/wtA"
git worktree add -q -b wtB "$T/wtB"
git worktree add -q -b wtC "$T/wtC"
for w in wtA wtB; do
  ln -s "$ROOT/node_modules" "$T/$w/node_modules"
  # 未ステージの変更を常に持たせ、lint-staged の部分ステージ経路 (stash 利用) を通す
  echo "export const dirty_$w = 1;" > "$T/$w/src/unstaged_$w.ts"
done

worker() {
  w="$1"; fail=0; i=1
  cd "$T/$w" || exit 2
  while [ "$i" -le "$COMMITS" ]; do
    printf 'export  const   v%s_%s  =  %s\n' "$w" "$i" "$i" >> "src/staged_$w.ts"
    git add "src/staged_$w.ts"
    if ! git commit -q -m "c$i" > "$T/$w.$i.log" 2>&1; then
      fail=$((fail + 1)); cp "$T/$w.$i.log" "$T/$w.fail.$i.log"
    fi
    i=$((i + 1))
  done
  echo "$fail" > "$T/$w.failcount"
}

# 実際の事故の再現: 別 worktree の担当が共有 stash を見つけ次第 pop する (#126)
intruder() {
  cd "$T/wtC" || exit 2
  n=0
  while [ ! -f "$T/stop" ]; do
    if [ -n "$(git stash list 2>/dev/null)" ]; then
      git stash pop -q > /dev/null 2>&1 && n=$((n + 1))
    fi
    sleep 0.05 2>/dev/null || sleep 1
  done
  echo "$n" > "$T/pops"
}

intruder & IP=$!
worker wtA &
worker wtB &
while [ ! -f "$T/wtA.failcount" ] || [ ! -f "$T/wtB.failcount" ]; do sleep 0.2; done
touch "$T/stop"
wait "$IP"

FA="$(cat "$T/wtA.failcount")"; FB="$(cat "$T/wtB.failcount")"
STASHES="$(git stash list | wc -l)"
CA="$(git rev-list --count main..wtA)"; CB="$(git rev-list --count main..wtB)"
echo "intruder (git stash pop) popped a shared stash $(cat "$T/pops" 2>/dev/null || echo 0) time(s)"
echo "commits ok: wtA=$CA/$COMMITS wtB=$CB/$COMMITS  failed: wtA=$FA wtB=$FB  stash entries: $STASHES"
if [ "$((FA + FB))" -gt 0 ]; then
  f="$(ls "$T"/*.fail.*.log 2>/dev/null | head -1)"
  echo "--- first failure log ($f) ---"; head -30 "$f"
fi
[ "$((FA + FB))" -eq 0 ] && [ "$STASHES" -eq 0 ] && [ "$CA" -eq "$COMMITS" ] && [ "$CB" -eq "$COMMITS" ]
