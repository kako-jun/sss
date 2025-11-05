import { ExternalLink } from 'lucide-react';
import { open } from '@tauri-apps/plugin-shell';

export function InfoSection() {
  const handleOpenGitHub = async () => {
    try {
      await open('https://github.com/kako-jun/sss');
    } catch (err) {
      console.error('Failed to open GitHub:', err);
    }
  };

  return (
    <div className="space-y-6">
      {/* アプリ情報 */}
      <div className="space-y-4">
        <h3 className="text-2xl font-bold text-white">Smart Slide Show (sss)</h3>
        <div className="text-gray-400 space-y-2">
          <div>バージョン: 1.0.0</div>
          <div>10万枚以上の写真を公平に表示するスライドショーアプリ</div>
        </div>
      </div>

      {/* GitHubリンク */}
      <div>
        <button
          onClick={handleOpenGitHub}
          className="flex items-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded transition-colors"
        >
          <ExternalLink size={18} />
          GitHubで見る
        </button>
      </div>
    </div>
  );
}
