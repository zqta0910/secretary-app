import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { VoyageAIClient } from "voyageai";

const DATA_DIR = path.resolve("data/meeting-minutes");
const TABLE = "meeting_minutes_chunks";
const EMBED_MODEL = "voyage-4-lite";
const EMBED_DIMENSION = 1024;
const MIN_CHUNK_LENGTH = 30;
const EMBED_BATCH_SIZE = 25;
const INSERT_BATCH_SIZE = 100;

const dryRun = process.argv.includes("--dry-run");

function parseFile(fileName) {
  const raw = fs.readFileSync(path.join(DATA_DIR, fileName), "utf8");
  const lines = raw.split(/\r?\n/);
  const separatorIndex = lines.findIndex((line) => line.trim() === "---");
  if (separatorIndex === -1) {
    throw new Error(`${fileName}: 「---」の区切り行が見つかりません`);
  }

  const header = {};
  for (const line of lines.slice(0, separatorIndex)) {
    const match = line.match(/^(title|date):\s*(.+)$/);
    if (match) header[match[1]] = match[2].trim();
  }
  if (!header.title) throw new Error(`${fileName}: title: がありません`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(header.date ?? "")) {
    throw new Error(`${fileName}: date: が YYYY-MM-DD 形式ではありません`);
  }

  const body = lines.slice(separatorIndex + 1).join("\n");
  return { fileName, title: header.title, date: header.date, body };
}

function chunkBody(body) {
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length < MIN_CHUNK_LENGTH && chunks.length > 0) {
      chunks[chunks.length - 1] += `\n\n${paragraph}`;
    } else {
      chunks.push(paragraph);
    }
  }

  if (chunks.length > 1 && chunks[0].length < MIN_CHUNK_LENGTH) {
    chunks[1] = `${chunks[0]}\n\n${chunks[1]}`;
    chunks.shift();
  }
  return chunks;
}

function buildChunks() {
  const files = fs
    .readdirSync(DATA_DIR)
    .filter((name) => name.endsWith(".md"))
    .sort();

  const rows = [];
  const perFile = [];
  for (const fileName of files) {
    const doc = parseFile(fileName);
    const chunks = chunkBody(doc.body);
    chunks.forEach((content, index) => {
      rows.push({
        meeting_title: doc.title,
        meeting_date: doc.date,
        chunk_index: index,
        content,
        source_file: doc.fileName,
        // 検索精度のため、ベクトル化する文章にはタイトルと日付を付ける(DBには本文だけ保存)
        embeddingInput: `${doc.title}(${doc.date})\n${content}`,
      });
    });
    perFile.push({ fileName, chunkCount: chunks.length });
  }
  return { rows, perFile };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function embedBatch(voyage, texts) {
  const maxAttempts = 6;
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await voyage.embed({
        input: texts,
        model: EMBED_MODEL,
        inputType: "document",
        outputDimension: EMBED_DIMENSION,
      });
      return result.data.map((item) => item.embedding);
    } catch (error) {
      const isRateLimit = error?.statusCode === 429;
      if (!isRateLimit || attempt === maxAttempts) throw error;
      console.log(`  Voyageのレート制限に達したため、25秒待って再試行します(${attempt}/${maxAttempts - 1})`);
      await sleep(25000);
    }
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value || value.startsWith("your-")) {
    throw new Error(`${name} が .env.local に設定されていません`);
  }
  return value;
}

async function main() {
  const { rows, perFile } = buildChunks();

  console.log(`議事録ファイル: ${perFile.length}件 / チャンク合計: ${rows.length}件`);
  for (const { fileName, chunkCount } of perFile) {
    console.log(`  ${fileName}: ${chunkCount}チャンク`);
  }

  if (dryRun) {
    console.log("\n--dry-run のため、ここで終了します(APIもDBも使っていません)。");
    return;
  }

  const voyage = new VoyageAIClient({ apiKey: requireEnv("VOYAGE_API_KEY") });
  const supabase = createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  );

  console.log("\nVoyage AIでベクトル化しています…");
  const embeddings = [];
  for (let i = 0; i < rows.length; i += EMBED_BATCH_SIZE) {
    const batch = rows.slice(i, i + EMBED_BATCH_SIZE);
    const vectors = await embedBatch(
      voyage,
      batch.map((row) => row.embeddingInput),
    );
    embeddings.push(...vectors);
    console.log(`  ${Math.min(i + EMBED_BATCH_SIZE, rows.length)} / ${rows.length}`);
  }

  console.log("\nSupabaseの既存データを削除して、新しいデータを保存します…");
  const { error: deleteError } = await supabase
    .from(TABLE)
    .delete()
    .not("id", "is", null);
  if (deleteError) throw new Error(`削除に失敗: ${deleteError.message}`);

  const insertRows = rows.map(({ embeddingInput, ...row }, index) => ({
    ...row,
    embedding: embeddings[index],
  }));
  for (let i = 0; i < insertRows.length; i += INSERT_BATCH_SIZE) {
    const { error: insertError } = await supabase
      .from(TABLE)
      .insert(insertRows.slice(i, i + INSERT_BATCH_SIZE));
    if (insertError) throw new Error(`保存に失敗: ${insertError.message}`);
  }

  console.log(`\n完了: ${insertRows.length}チャンクを保存しました。`);
}

main().catch((error) => {
  console.error(`\nエラー: ${error.message}`);
  process.exit(1);
});
