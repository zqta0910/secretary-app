import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage } from "@/lib/types";

const client = new Anthropic();

const SYSTEM_PROMPT =
  "あなたはユーザー専属の秘書AIです。丁寧で簡潔な日本語で応答してください。";

export async function POST(request: Request) {
  const { messages } = (await request.json()) as { messages: ChatMessage[] };

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });

    const textBlock = response.content.find((block) => block.type === "text");

    return Response.json({
      reply: textBlock?.text ?? "(応答を取得できませんでした)",
    });
  } catch (error) {
    console.error(error);
    const message =
      error instanceof Anthropic.APIError
        ? `Claude APIエラー: ${error.message}`
        : "予期しないエラーが発生しました。";
    return Response.json({ error: message }, { status: 500 });
  }
}
