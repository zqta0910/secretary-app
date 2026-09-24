# 作業ログ

## 2026-09-20
- やったこと: `secretary-app`をNext.js(TypeScript/Tailwind/App Router)で初期化。`~/vibe-apps/`配下に他アプリと合流。
  `@supabase/supabase-js`と`@anthropic-ai/sdk`を追加。memo-appと同じSupabaseプロジェクトに接続する方針(A案)で設計中。
- 変更ファイル: プロジェクト全体(create-next-app)、package.json
- 詰まった点: 特になし。

## 2026-09-24
- やったこと: Anthropic APIキーを発行(期限1ヶ月、$5チャージ)し`.env.local`に設定、疎通確認OK。
  チャット画面(`ChatApp.tsx`)と、サーバー側でClaude APIを呼ぶ`/api/chat`ルートを実装。ブラウザでの会話動作を確認。
  Remote Controlをオンにして、スマホ/iPadからこのセッションを見られるようにした。
- 変更ファイル: src/app/page.tsx, src/app/api/chat/route.ts, src/components/ChatApp.tsx, src/lib/types.ts, .env.local
- 詰まった点: Cursorで`.env.local`を開いたとき、サイドバーが別プロジェクト(household-app)のままで少し混乱した
  → ファイルタブ自体は正しいパスだったので実害なし。次は必要ならCursorで対象フォルダを開き直す。
  まだSupabase(memosテーブル)とは繋がっていない、次回はAIにメモの検索・編集をさせる「ツール」部分を実装する。
