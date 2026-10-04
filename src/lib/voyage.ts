import { VoyageAIClient } from "voyageai";

// 登録時(scripts/ingest-meeting-minutes.mjs)・SQLの vector(1024) と必ず一致させること
export const EMBED_MODEL = "voyage-4-lite";
export const EMBED_DIMENSION = 1024;

export function getVoyageClient() {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey || apiKey.startsWith("your-")) {
    throw new Error(
      "Voyage AI の環境変数が未設定です。`.env.local` に VOYAGE_API_KEY を追加してください。",
    );
  }
  return new VoyageAIClient({ apiKey });
}

export const RERANK_MODEL = "rerank-3-lite";

// 検索で拾った候補を、質問と1件ずつ突き合わせて関連度(0〜1)を採点し直す
export async function rerankDocuments(query: string, documents: string[]) {
  const result = await getVoyageClient().rerank({
    query,
    documents,
    model: RERANK_MODEL,
    topK: documents.length,
  });
  return (result.data ?? []).map((item) => ({
    index: item.index ?? -1,
    score: item.relevanceScore ?? 0,
  }));
}

export async function embedQuery(text: string) {
  const result = await getVoyageClient().embed({
    input: text,
    model: EMBED_MODEL,
    inputType: "query",
    outputDimension: EMBED_DIMENSION,
  });
  const embedding = result.data?.[0]?.embedding;
  if (!embedding) throw new Error("検索クエリのベクトル化に失敗しました");
  return embedding;
}
