import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage } from "@/lib/types";
import { getSupabase } from "@/lib/supabase";

const client = new Anthropic();

const SYSTEM_PROMPT = `あなたはユーザー専属の秘書AIです。ユーザーの3種類のデータ(メモ・TODO・家計簿の収支記録)を確認・編集する役割を持っています。
- メモについては search_memos / update_memo を使ってください。
- TODOについては search_todos / update_todo を使ってください。
- 家計簿の収支記録については search_transactions / update_transaction を使ってください。
- 何かを編集してほしいと言われたら、まず該当する search_* ツールで対象のIDを特定してから update_* を使ってください。対象が曖昧なときや、メモ・TODO・家計簿のどれを指しているか分からないときは推測せず、聞き返してください。
- 重要: メモ・TODO・家計簿の内容について聞かれたときは、記憶や推測で答えず、必ず対応する search_* ツールを実際に呼び出してから回答してください。ツールを一度も使わずに「データがありません」「見当たりません」と断定することは禁止です。
丁寧で簡潔な日本語で応答してください。`;

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
];

const STATUS_LABELS: Record<string, string> = {
  search_memos: "メモを検索しています…",
  update_memo: "メモを更新しています…",
  search_todos: "TODOを検索しています…",
  update_todo: "TODOを更新しています…",
  search_transactions: "家計簿を検索しています…",
  update_transaction: "家計簿を更新しています…",
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

export async function POST(request: Request) {
  const { messages } = (await request.json()) as { messages: ChatMessage[] };

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
          system: SYSTEM_PROMPT,
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
            system: SYSTEM_PROMPT,
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
