#!/bin/sh
# 並行 worktree で pre-commit(lint-staged) を同時に走らせても stash が汚れずコミットが全て成功するかを検証する (#126)
#
# 使い方:
#   scripts/verify-concurrent-precommit.sh            # 現行の .husky/pre-commit (--no-stash) を検証
#   scripts/verify-concurrent-precommit.sh --legacy   # --no-stash を外した旧挙動を再現（比較用）
#   COMMITS=20 scripts/verify-concurrent-precommit.sh # 1 worktree あたりのコミット回数 (既定 20)
#
# 実リポジトリの stash / worktree には一切触らず、使い捨ての一時リポジトリ内だけで動く。
# 一時領域は $E2E_TMP_BASE (既定 $HOME/.cache/e2etmp) 配下。終了コード 0 = 全コミット成功かつ stash 0 件。
set -u

LEGACY=0
[ "${1:-}" = "--legacy" ] && LEGACY=1
COMMITS="${COMMITS:-20}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${E2E_TMP_BASE:-$HOME/.cache/e2etmp}"
mkdir -p "$BASE"
T="$(mktemp -d "$BASE/precommit-XXXXXX")"
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
cp "$ROOT/package.json" "$ROOT/eslint.config.js" "$ROOT/tsconfig.json" . 2>/dev/null
[ -f "$ROOT/.prettierrc" ] && cp "$ROOT/.prettierrc" .
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
    if [ -n "$(git stash list)" ]; then
      git stash pop -q > /dev/null 2>&1 && n=$((n + 1))
    fi
  done
  echo "$n" > "$T/pops"
}

intruder & IP=$!
worker wtA & worker wtB &
wait %2 %3 2>/dev/null
while [ ! -f "$T/wtA.failcount" ] || [ ! -f "$T/wtB.failcount" ]; do sleep 0.2; done
touch "$T/stop"
wait "$IP"

FA="$(cat "$T/wtA.failcount")"; FB="$(cat "$T/wtB.failcount")"
STASHES="$(git stash list | wc -l)"
CA="$(git rev-list --count main..wtA)"; CB="$(git rev-list --count main..wtB)"
echo "intruder (git stash pop) popped a shared stash $(cat "$T/pops") time(s)"
echo "commits ok: wtA=$CA/$COMMITS wtB=$CB/$COMMITS  failed: wtA=$FA wtB=$FB  stash entries: $STASHES"
if [ "$((FA + FB))" -gt 0 ]; then
  f="$(ls "$T"/*.fail.*.log 2>/dev/null | head -1)"
  echo "--- first failure log ($f) ---"; head -30 "$f"
fi
[ "$((FA + FB))" -eq 0 ] && [ "$STASHES" -eq 0 ] && [ "$CA" -eq "$COMMITS" ] && [ "$CB" -eq "$COMMITS" ]
