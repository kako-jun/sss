import { X, Plus } from 'lucide-react';
import { useState, useEffect } from 'react';
import { getIgnorePatterns, removeIgnorePattern, addIgnorePattern } from '../../lib/tauri';
import type { IgnoreRule } from '../../types';

export function ExcludeRulesSection() {
  const [rules, setRules] = useState<IgnoreRule[]>([]);
  const [newPattern, setNewPattern] = useState('');
  const [loading, setLoading] = useState(true);
  const [addError, setAddError] = useState<string | null>(null);

  useEffect(() => {
    getIgnorePatterns()
      .then((result) => {
        setRules(result);
        setLoading(false);
      })
      .catch((err) => {
        console.error('Failed to load ignore patterns:', err);
        setLoading(false);
      });
  }, []);

  const handleRemove = async (pattern: string, ruleType: IgnoreRule['ruleType']) => {
    try {
      await removeIgnorePattern(pattern, ruleType);
      setRules((prev) => prev.filter((r) => !(r.pattern === pattern && r.ruleType === ruleType)));
    } catch (err) {
      console.error('Failed to remove ignore pattern:', err);
    }
  };

  const handleAdd = async () => {
    const trimmed = newPattern.trim();
    // 手動追加は常に glob として扱うため、同じ pattern+ruleType=glob の重複だけ弾く
    // （撮影日ルールと文字列が同じでも共存できる。#61レビュー nit の複合キー化に対応）
    if (!trimmed || rules.some((r) => r.pattern === trimmed && r.ruleType === 'glob')) return;

    try {
      // 手動追加は常に通常globルールとして扱う（撮影日ルールはオーバーレイの
      // 「撮影日付で除外」からのみ作られる）
      await addIgnorePattern(trimmed);
      setRules((prev) => [...prev, { pattern: trimmed, ruleType: 'glob' }]);
      setNewPattern('');
      setAddError(null);
    } catch (err) {
      // #61レビュー S2: 不正なglob（閉じていない `{` 等）はバックエンドがErrを返す
      // ようになった。従来はconsole.errorに流すだけで画面上は何も起きなかったので、
      // ユーザーに失敗を伝える。
      console.error('Failed to add ignore pattern:', err);
      setAddError(typeof err === 'string' ? err : 'パターンの追加に失敗しました');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleAdd();
    }
  };

  if (loading) {
    return <div className="text-white/30 text-sm">読み込み中...</div>;
  }

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-medium text-white/50 uppercase tracking-wider">除外ルール</h3>

      {rules.length === 0 ? (
        <div className="text-white/30 text-sm">除外ルールはありません</div>
      ) : (
        <div className="space-y-1">
          {rules.map(({ pattern, ruleType }) => (
            <div
              key={`${pattern}-${ruleType}`}
              className="flex items-center justify-between gap-2 px-3 py-1.5 bg-black/40 rounded border border-white/8 group"
            >
              <div className="flex items-center gap-2 min-w-0">
                {ruleType === 'date' && (
                  <span className="shrink-0 px-1.5 py-0.5 text-[10px] leading-none rounded bg-white/10 text-white/50">
                    撮影日
                  </span>
                )}
                <span className="text-white/55 text-sm truncate">{pattern}</span>
              </div>
              <button
                onClick={() => handleRemove(pattern, ruleType)}
                className="p-1 hover:bg-white/8 rounded transition-colors shrink-0 opacity-0 group-hover:opacity-100"
                title="解除"
              >
                <X className="w-3.5 h-3.5 text-white/30 hover:text-white/60" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <input
          type="text"
          value={newPattern}
          onChange={(e) => {
            setNewPattern(e.target.value);
            setAddError(null);
          }}
          onKeyDown={handleKeyDown}
          placeholder="パターンを入力（例: **/thumbs/）"
          className="flex-1 px-3 py-2 bg-black/40 text-white/50 rounded border border-white/8 focus:outline-none focus:border-white/20 text-sm"
        />
        <button
          onClick={handleAdd}
          disabled={!newPattern.trim()}
          className="flex items-center gap-2 px-4 py-2 bg-white/8 hover:bg-white/15 text-white/60 hover:text-white/80 rounded border border-white/8 transition shrink-0 text-sm disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <Plus className="w-4 h-4" />
          追加
        </button>
      </div>
      {addError && <div className="text-red-400/80 text-sm">{addError}</div>}
    </div>
  );
}
