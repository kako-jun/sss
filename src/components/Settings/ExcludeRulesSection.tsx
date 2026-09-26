import { X, Plus } from 'lucide-react';
import { useState, useEffect } from 'react';
import { getIgnorePatterns, removeIgnorePattern, addIgnorePattern } from '../../lib/tauri';
import type { IgnoreRule } from '../../types';

export function ExcludeRulesSection() {
  const [rules, setRules] = useState<IgnoreRule[]>([]);
  const [newPattern, setNewPattern] = useState('');
  const [loading, setLoading] = useState(true);

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

  const handleRemove = async (pattern: string) => {
    try {
      await removeIgnorePattern(pattern);
      setRules((prev) => prev.filter((r) => r.pattern !== pattern));
    } catch (err) {
      console.error('Failed to remove ignore pattern:', err);
    }
  };

  const handleAdd = async () => {
    const trimmed = newPattern.trim();
    if (!trimmed || rules.some((r) => r.pattern === trimmed)) return;

    try {
      // 手動追加は常に通常globルールとして扱う（撮影日ルールはオーバーレイの
      // 「撮影日付で除外」からのみ作られる）
      await addIgnorePattern(trimmed);
      setRules((prev) => [...prev, { pattern: trimmed, ruleType: 'glob' }]);
      setNewPattern('');
    } catch (err) {
      console.error('Failed to add ignore pattern:', err);
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
              key={pattern}
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
                onClick={() => handleRemove(pattern)}
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
          onChange={(e) => setNewPattern(e.target.value)}
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
    </div>
  );
}
