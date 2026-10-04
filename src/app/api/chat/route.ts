import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage } from "@/lib/types";
import { getSupabase } from "@/lib/supabase";
import { embedQuery, rerankDocuments } from "@/lib/voyage";

const client = new Anthropic();

// 議事録検索は2段階: ①ベクトル検索で候補を広めに拾う → ②リランキングで関連度を採点し直し、
// 一定以上のものだけを返す。①の類似度は数値の絶対値が当てにならない(0.3〜0.7に圧縮される)ため、
// 「該当なし」の判定は②のスコアで行う。②のしきい値0.60は16個の質問での実測に基づく仮値
// (関連ありの最低0.70、関連なしの最高0.52)。
const MINUTES_CANDIDATE_THRESHOLD = 0.25;
const MINUTES_CANDIDATE_COUNT = 10;
const MINUTES_RELEVANCE_THRESHOLD = 0.6;
const MINUTES_RESULT_COUNT = 5;
const MINUTES_NO_MATCH_NOTE = "質問に関連する記録が見つかりませんでした";

function buildSystemPrompt(today: string) {
  return `あなたはユーザー専属の秘書AIです。ユーザーのメモ・TODO・家計簿の収支記録(確認・編集が可能)と、会議議事録(検索のみ)を扱います。
今日の日付は ${today} です。
- メモについては search_memos / update_memo を使ってください。
- TODOについては search_todos / update_todo を使ってください。
- 家計簿の収支記録については search_transactions / update_transaction を使ってください。
- 何かを編集してほしいと言われたら、まず該当する search_* ツールで対象のIDを特定してから update_* を使ってください。編集の対象が複数あって特定できないときは、推測せず聞き返してください。
- 稼働率・売上・メニュー・設備・人員・クレーム・販促など、業務に関する質問で、メモ・TODO・家計簿のどれに当たるか分からないときは、聞き返す前に、まず search_meeting_minutes で検索してください。必要なら他の search_* も併用してください。
- 会議議事録(クレームの傾向、決定事項、設備の状況など)について聞かれたときは、search_meeting_minutes を使って検索してください。「先月」「今月」「3月」のような期間の指定があるときは、今日の日付を基準に date_from / date_to(YYYY-MM-DD)を計算して渡してください(例:今日が2026-09-30なら「先月」は 2026-08-01〜2026-08-31)。
- search_meeting_minutes の結果は会議ごとにまとまっていて、各段落に matched(質問にヒットしたか)が付いています。matched が false の段落は同じ会議の補足情報です。質問に関係する段落だけを根拠にし、無関係な段落は使わないでください。ただし「傾向」「まとめ」「一覧」のような質問では、matched が false でも質問に関係する段落は漏れなく含めてください。
- 議事録の内容を根拠に回答するときは、根拠にした議事録の「日付」と「タイトル」を必ず明記してください(例:「2026年8月15日の『8月度 クレーム対応会議』によると…」)。
- search_meeting_minutes の results が空だった場合は、他の情報で補ったり推測したりせず、必ず「該当する記録がありません」と回答してください。results が空でなくても、内容が質問の答えになっていなければ同様に「該当する記録がありません」と回答し、関連の薄い結果を無理にこじつけて答えることは禁止です。
- ツールの結果が error だった場合は「該当する記録がありません」とは言わず、エラーの内容を伝えたうえで、少し時間をおいて再度試すよう案内してください。
- 重要: メモ・TODO・家計簿・会議議事録の内容について聞かれたときは、記憶や推測で答えず、必ず対応する search_* ツールを実際に呼び出してから回答してください。ツールを一度も使わずに「データがありません」「見当たりません」と断定することは禁止です。
丁寧で簡潔な日本語で応答してください。`;
}

const tools: Anthropic.Tool[] = [
  {
    name: "search_memos",
    description:
      "メモを検索する。キーワードを指定するとタイトル・本文の部分一致で絞り込み、省略すると更新が新しい順で最大10件を返す。",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "検索キーワード。省略可。",
        },
      },
    },
  },
  {
    name: "update_memo",
    description: "指定したIDのメモを更新する。変更したい項目だけ指定すればよい。",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "更新するメモのID(search_memosの結果から取得)" },
        title: { type: "string", description: "新しいタイトル(変更する場合のみ)" },
        body: { type: "string", description: "新しい本文(変更する場合のみ)" },
        important: { type: "boolean", description: "重要フラグ(変更する場合のみ)" },
      },
      required: ["id"],
    },
  },
  {
    name: "search_todos",
    description:
      "TODOを検索する。キーワードを指定するとタイトルの部分一致で絞り込み、省略すると新しい順で最大10件を返す。",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "検索キーワード。省略可。" },
      },
    },
  },
  {
    name: "update_todo",
    description:
      "指定したIDのTODOを更新する。タイトルの変更や、完了/未完了の切り替えに使う。",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "更新するTODOのID(search_todosの結果から取得)" },
        title: { type: "string", description: "新しいタイトル(変更する場合のみ)" },
        completed: { type: "boolean", description: "完了フラグ(変更する場合のみ)" },
      },
      required: ["id"],
    },
  },
  {
    name: "search_transactions",
    description:
      "家計簿の収支記録を検索する。キーワードを指定するとカテゴリ・メモの部分一致で絞り込み、省略すると日付が新しい順で最大10件を返す。",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "検索キーワード。省略可。" },
      },
    },
  },
  {
    name: "update_transaction",
    description:
      "指定したIDの収支記録を更新する。金額・カテゴリ・メモ・日付を変更する場合に使う。",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "更新する記録のID(search_transactionsの結果から取得)" },
        amount: { type: "number", description: "金額(変更する場合のみ)" },
        category: { type: "string", description: "カテゴリ(変更する場合のみ)" },
        memo: { type: "string", description: "メモ(変更する場合のみ)" },
        date: { type: "string", description: "日付、YYYY-MM-DD形式(変更する場合のみ)" },
      },
      required: ["id"],
    },
  },
  {
    name: "search_meeting_minutes",
    description:
      "会議議事録を、キーワード一致ではなく意味の近さで検索する。リゾート・レストラン運営の定例会議(運営会議・レストラン部門会議・クレーム対応会議・施設メンテナンス会議・マーケティング会議)の議事録が対象で、稼働率、メニュー、設備の点検・修繕、人員・採用、クレーム、販促・イベントなどの運営上の話題が記録されている。結果は会議ごとにまとまっており、出典の日付(date)・タイトル(title)と、その会議の段落(paragraphs)が含まれる。各段落の matched が true のものが質問にヒットした段落で、false のものは同じ会議の他の段落(補足情報)。該当する記録がない場合、results は空になる。",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "検索したい内容(質問文でよい)" },
        date_from: {
          type: "string",
          description: "この日付以降の議事録に絞る。YYYY-MM-DD形式。省略可。",
        },
        date_to: {
          type: "string",
          description: "この日付以前の議事録に絞る。YYYY-MM-DD形式。省略可。",
        },
      },
      required: ["query"],
    },
  },
];

const STATUS_LABELS: Record<string, string> = {
  search_memos: "メモを検索しています…",
  update_memo: "メモを更新しています…",
  search_todos: "TODOを検索しています…",
  update_todo: "TODOを更新しています…",
  search_transactions: "家計簿を検索しています…",
  update_transaction: "家計簿を更新しています…",
  search_meeting_minutes: "議事録を検索しています…",
};

async function searchMemos(query?: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("memos")
    .select("id, title, body, important, updated_at")
    .order("updated_at", { ascending: false });

  if (error) return { error: error.message };

  const keyword = query?.trim().toLowerCase();
  const memos = keyword
    ? data.filter(
        (m) =>
          m.title.toLowerCase().includes(keyword) ||
          m.body.toLowerCase().includes(keyword),
      )
    : data;

  return { memos: memos.slice(0, 10) };
}

async function updateMemo(input: {
  id: string;
  title?: string;
  body?: string;
  important?: boolean;
}) {
  const { id, ...fields } = input;
  if (Object.keys(fields).length === 0) {
    return { error: "変更する項目が指定されていません" };
  }
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("memos")
    .update(fields)
    .eq("id", id)
    .select()
    .single();

  if (error) return { error: error.message };
  return { memo: data };
}

async function searchTodos(query?: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("todos")
    .select("id, title, completed, created_at")
    .order("created_at", { ascending: false });

  if (error) return { error: error.message };

  const keyword = query?.trim().toLowerCase();
  const todos = keyword
    ? data.filter((t) => t.title.toLowerCase().includes(keyword))
    : data;

  return { todos: todos.slice(0, 10) };
}

async function updateTodo(input: {
  id: string;
  title?: string;
  completed?: boolean;
}) {
  const { id, ...fields } = input;
  if (Object.keys(fields).length === 0) {
    return { error: "変更する項目が指定されていません" };
  }
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("todos")
    .update(fields)
    .eq("id", id)
    .select()
    .single();

  if (error) return { error: error.message };
  return { todo: data };
}

async function searchTransactions(query?: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("transactions")
    .select("id, type, amount, category, memo, date")
    .order("date", { ascending: false });

  if (error) return { error: error.message };

  const keyword = query?.trim().toLowerCase();
  const transactions = keyword
    ? data.filter(
        (t) =>
          t.category.toLowerCase().includes(keyword) ||
          t.memo.toLowerCase().includes(keyword),
      )
    : data;

  return { transactions: transactions.slice(0, 10) };
}

async function updateTransaction(input: {
  id: string;
  amount?: number;
  category?: string;
  memo?: string;
  date?: string;
}) {
  const { id, ...fields } = input;
  if (Object.keys(fields).length === 0) {
    return { error: "変更する項目が指定されていません" };
  }
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("transactions")
    .update(fields)
    .eq("id", id)
    .select()
    .single();

  if (error) return { error: error.message };
  return { transaction: data };
}

type MeetingMinutesRow = {
  meeting_title: string;
  meeting_date: string;
  chunk_index: number;
  content: string;
};

const meetingKey = (row: { meeting_date: string; meeting_title: string }) =>
  `${row.meeting_date}|${row.meeting_title}`;

async function searchMeetingMinutes(input: {
  query: string;
  date_from?: string;
  date_to?: string;
}) {
  try {
    const queryEmbedding = await embedQuery(input.query);

    const supabase = getSupabase();
    const { data, error } = await supabase.rpc("match_meeting_minutes", {
      query_embedding: queryEmbedding,
      match_threshold: MINUTES_CANDIDATE_THRESHOLD,
      match_count: MINUTES_CANDIDATE_COUNT,
      date_from: input.date_from ?? null,
      date_to: input.date_to ?? null,
    });
    if (error) return { error: error.message };

    const candidates = (data ?? []) as MeetingMinutesRow[];
    if (candidates.length === 0) {
      return { results: [], note: MINUTES_NO_MATCH_NOTE };
    }

    // 登録時のベクトル化と同じく、タイトルと日付を付けた形で採点させる
    const scored = await rerankDocuments(
      input.query,
      candidates.map((c) => `${c.meeting_title}(${c.meeting_date})\n${c.content}`),
    );

    const hits = scored
      .filter((s) => s.index >= 0 && s.score >= MINUTES_RELEVANCE_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, MINUTES_RESULT_COUNT)
      .map((s) => ({ chunk: candidates[s.index], score: s.score }));

    if (hits.length === 0) {
      return { results: [], note: MINUTES_NO_MATCH_NOTE };
    }

    // ヒットした段落が属する会議の、他の段落も取り出す(文脈と、集計的な質問での取りこぼし防止のため)
    const hitScoreByChunk = new Map(
      hits.map((h) => [`${meetingKey(h.chunk)}|${h.chunk.chunk_index}`, h.score]),
    );
    const bestScoreByMeeting = new Map<string, number>();
    for (const h of hits) {
      const key = meetingKey(h.chunk);
      bestScoreByMeeting.set(key, Math.max(bestScoreByMeeting.get(key) ?? 0, h.score));
    }

    const hitDates = [...new Set(hits.map((h) => h.chunk.meeting_date))];
    const { data: siblingData, error: siblingError } = await supabase
      .from("meeting_minutes_chunks")
      .select("meeting_title, meeting_date, chunk_index, content")
      .in("meeting_date", hitDates)
      .order("chunk_index", { ascending: true });
    if (siblingError) return { error: siblingError.message };

    const meetings = new Map<
      string,
      {
        title: string;
        date: string;
        paragraphs: { content: string; matched: boolean; relevance?: number }[];
      }
    >();
    for (const row of (siblingData ?? []) as MeetingMinutesRow[]) {
      const key = meetingKey(row);
      if (!bestScoreByMeeting.has(key)) continue;
      const meeting = meetings.get(key) ?? {
        title: row.meeting_title,
        date: row.meeting_date,
        paragraphs: [],
      };
      const score = hitScoreByChunk.get(`${key}|${row.chunk_index}`);
      meeting.paragraphs.push(
        score === undefined
          ? { content: row.content, matched: false }
          : { content: row.content, matched: true, relevance: Number(score.toFixed(3)) },
      );
      meetings.set(key, meeting);
    }

    const results = [...meetings.entries()]
      .sort((a, b) => (bestScoreByMeeting.get(b[0]) ?? 0) - (bestScoreByMeeting.get(a[0]) ?? 0))
      .map(([, meeting]) => meeting);

    return { results };
  } catch (error) {
    console.error(error);
    if ((error as { statusCode?: number }).statusCode === 429) {
      return {
        error:
          "Voyage AIのリクエスト制限に達しました。1分ほど待ってから、もう一度お試しください。",
      };
    }
    const message = error instanceof Error ? error.message : "不明なエラー";
    return { error: `議事録の検索中にエラーが発生しました: ${message}` };
  }
}

export async function POST(request: Request) {
  const { messages } = (await request.json()) as { messages: ChatMessage[] };

  // sv-SE ロケールは YYYY-MM-DD 形式で出力される(サーバーのローカル日付)
  const today = new Date().toLocaleDateString("sv-SE");
  const systemPrompt = buildSystemPrompt(today);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };

      try {
        const history: Anthropic.MessageParam[] = messages.map((m) => ({
          role: m.role,
          content: m.content,
        }));

        send({ type: "status", label: "考えています…" });
        let response = await client.messages.create({
          model: "claude-haiku-4-5",
          max_tokens: 1024,
          system: systemPrompt,
          tools,
          messages: history,
        });

        while (response.stop_reason === "tool_use") {
          history.push({ role: "assistant", content: response.content });

          const toolResults: Anthropic.ToolResultBlockParam[] = [];
          for (const block of response.content) {
            if (block.type !== "tool_use") continue;

            send({
              type: "status",
              label: STATUS_LABELS[block.name] ?? `${block.name}を実行しています…`,
            });

            let result: unknown;
            if (block.name === "search_memos") {
              const input = block.input as { query?: string };
              result = await searchMemos(input.query);
            } else if (block.name === "update_memo") {
              const input = block.input as {
                id: string;
                title?: string;
                body?: string;
                important?: boolean;
              };
              result = await updateMemo(input);
            } else if (block.name === "search_todos") {
              const input = block.input as { query?: string };
              result = await searchTodos(input.query);
            } else if (block.name === "update_todo") {
              const input = block.input as {
                id: string;
                title?: string;
                completed?: boolean;
              };
              result = await updateTodo(input);
            } else if (block.name === "search_transactions") {
              const input = block.input as { query?: string };
              result = await searchTransactions(input.query);
            } else if (block.name === "update_transaction") {
              const input = block.input as {
                id: string;
                amount?: number;
                category?: string;
                memo?: string;
                date?: string;
              };
              result = await updateTransaction(input);
            } else if (block.name === "search_meeting_minutes") {
              const input = block.input as {
                query: string;
                date_from?: string;
                date_to?: string;
              };
              result = await searchMeetingMinutes(input);
            } else {
              result = { error: "未知のツールです" };
            }

            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: JSON.stringify(result),
            });
          }

          history.push({ role: "user", content: toolResults });

          send({ type: "status", label: "考えています…" });
          response = await client.messages.create({
            model: "claude-haiku-4-5",
            max_tokens: 1024,
            system: systemPrompt,
            tools,
            messages: history,
          });
        }

        const textBlock = response.content.find((b) => b.type === "text");
        send({
          type: "final",
          reply: textBlock?.text ?? "(応答を取得できませんでした)",
        });
      } catch (error) {
        console.error(error);
        const message =
          error instanceof Anthropic.APIError
            ? `Claude APIエラー: ${error.message}`
            : "予期しないエラーが発生しました。";
        send({ type: "error", message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
  });
}
