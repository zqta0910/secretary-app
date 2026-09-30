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

## 2026-09-25
- やったこと: GitHubにpush(zqta0910/secretary-app、publicに設定)。
  Claudeに`search_memos`/`update_memo`ツールを実装し、実際にmemo-appのSupabaseデータを検索・編集できるようになった。
  ストリーミング形式で「考えています…」「メモを検索しています…」の経過表示 + バウンドアニメーションを追加。
  「メモを編集する」ボタンを、番号付きリストから選ぶ方式に改良(番号 or タイトル部分一致で選択 → 変更内容を聞く → Claudeへは確定したIDを渡す)。
- 変更ファイル: src/app/api/chat/route.ts, src/components/ChatApp.tsx
- 詰まった点: Supabase無料プランがAPI無操作で自動一時停止(Pause)していて`fetch failed`エラーが発生。
  DNS(NXDOMAIN)まで遡って原因を切り分け、ダッシュボードから再開して解決。
  → 今後もしばらく触らない期間が空くと同じ現象が起きうる。

## 2026-09-27
- やったこと: todo-app(todosテーブル)・household-app(transactionsテーブル)用のツール(search/update)を追加し、
  memo・TODO・家計簿の3アプリを横断する秘書AIの土台が完成。新しいUI(ボタン)は追加せず、自然文だけで
  AIが自分でどのツールを使うか判断できることを確認(「TODO見せて」「家計簿の支出見せて」「ワークアウトを完了にして」など)。
- 変更ファイル: src/app/api/chat/route.ts
- 詰まった点: 特になし。次回はUIの見た目をCursorで個別に整えていく予定。

- 追記: 実際に触っていたら、家計簿に31件データがあるのに「データがありません」とAIが答える現象が発生。
  ネットワークログで確認したところ、AIがsearch_transactionsツールを一度も呼ばずに答えていたのが原因(コードのバグではなく、
  AIの判断が確率的に外れた一例)。同じ会話を再現しても毎回起きるわけではなかった。
  システムプロンプトに「ツールを使わずに断定するのは禁止」という一文を追加して対策。完全解決ではなく発生頻度を下げる対応。

## 2026-09-28
- やったこと: 架空の会議議事録に対するRAG(意味検索)機能の**計画**を作成(実装はまだ)。
  プランモードでPlanエージェントによる設計検証+Web調査(embeddingサービスの選定、pgvectorの制約など)を実施し、
  `/Users/zqta/.claude/plans/pasted-content-id-7ba2-ai-rag-shimmering-cookie.md` に保存。
  1回目のフィードバックを受けて、①RLS/権限設計(service_roleキーの導入)、②「該当なし」判定のしきい値設計、
  ③「先月」等の期間指定への対応、④embedding時にタイトル・日付を付与する方式、⑤Voyage AIの日本語対応状況の裏付け調査、
  の5点を修正版に反映。次回は修正版プランの再確認から。
- 変更ファイル: なし(プランファイルのみ、アプリのコードは未変更)
- 詰まった点: Voyage AIの日本語特化ベンチマークの明確な裏付けが見つからず、正直に「不明」として計画に明記。
  対策として、本実装前に日本語の文章ペアで簡易テストする手順を計画に組み込んだ。

## 2026-09-30
- やったこと: 修正版プランを承認し、RAG機能の実装を開始(Autoモード)。
  `supabase/meeting-minutes-schema.sql`を作成・Supabaseで実行し、チャンク用テーブルとmatch_meeting_minutes関数を用意。
  anonキーでのINSERTが拒否されること(RLS設計通り)を確認。Voyage AI・Supabase service_roleキーを`.env.local`に設定。
  `voyageai`パッケージを導入し、日本語文章ペアでの簡易テストを実施:類似文の類似度0.97(良好)、無関係な文でも0.64
  (計画のしきい値0.5より高い)という結果になり、しきい値は実データ投入後に調整が必要と判明。
  ダミー議事録35件(3〜9月、5種類の定例会議×7ヶ月分)を生成し`data/meeting-minutes/`に保存。
  8月のクレーム会議に具体的な内容(レストラン提供遅延・プール混雑・Wi-Fi不安定)を盛り込み、
  「先月のクレームの傾向は?」という質問での期間指定+意味検索のテストに使える設計にした。
- 変更ファイル: supabase/meeting-minutes-schema.sql, .env.example, .env.local, package.json/package-lock.json(voyageai追加),
  data/meeting-minutes/*.md(35件)
- 詰まった点: しきい値0.5が短い一般的な文では機能しない可能性(上記の通り)。次回、実データ投入後に調整する。
  次回は scripts/ingest-meeting-minutes.mjs の実装からスタート。
