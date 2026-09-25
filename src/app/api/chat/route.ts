import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage } from "@/lib/types";
import { getSupabase } from "@/lib/supabase";

const client = new Anthropic();

const SYSTEM_PROMPT = `あなたはユーザー専属の秘書AIです。ユーザーのメモ(memosテーブル)を確認・編集する役割を持っています。
- メモの内容を聞かれたら search_memos を使って調べてから答えてください。
- メモを編集してほしいと言われたら、まず search_memos で対象のメモのIDを特定してから update_memo を使ってください。対象が曖昧なときは推測せず、どのメモか聞き返してください。
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
];

const STATUS_LABELS: Record<string, string> = {
  search_memos: "メモを検索しています…",
  update_memo: "メモを更新しています…",
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
