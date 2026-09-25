"use client";

import { FormEvent, useRef, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type { ChatMessage, Memo } from "@/lib/types";

type MemoOption = Pick<Memo, "id" | "title">;

type EditFlow =
  | { step: "idle" }
  | { step: "choosing"; options: MemoOption[] }
  | { step: "editing"; target: MemoOption };

function TypingDots() {
  return (
    <span className="inline-flex gap-1">
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400 [animation-delay:-0.3s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400 [animation-delay:-0.15s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400" />
    </span>
  );
}

function formatOptionList(options: MemoOption[]) {
  return options.map((m, i) => `${i + 1}. ${m.title}`).join("\n");
}

export default function ChatApp() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editFlow, setEditFlow] = useState<EditFlow>({ step: "idle" });
  const inputRef = useRef<HTMLInputElement>(null);

  const loading = status !== null;

  function addAssistantMessage(content: string) {
    setMessages((prev) => [...prev, { role: "assistant", content }]);
  }

  async function callChatApi(text: string, apiText: string) {
    const displayMessages: ChatMessage[] = [
      ...messages,
      { role: "user", content: text },
    ];
    const apiMessages: ChatMessage[] = [
      ...messages,
      { role: "user", content: apiText },
    ];
    setMessages(displayMessages);
    setInput("");
    setError(null);
    setStatus("考えています…");

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: apiMessages }),
      });
      if (!res.body) throw new Error("応答を受信できませんでした");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as
            | { type: "status"; label: string }
            | { type: "final"; reply: string }
            | { type: "error"; message: string };

          if (event.type === "status") {
            setStatus(event.label);
          } else if (event.type === "final") {
            addAssistantMessage(event.reply);
          } else if (event.type === "error") {
            setError(event.message);
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "エラーが発生しました");
    } finally {
      setStatus(null);
    }
  }

  async function handleShowMemos() {
    setEditFlow({ step: "idle" });
    await callChatApi("メモを見せて", "メモを見せて");
  }

  async function handleStartEdit() {
    setEditFlow({ step: "idle" });
    setError(null);
    setStatus("メモ一覧を取得しています…");
    try {
      const supabase = getSupabase();
      const { data, error: fetchError } = await supabase
        .from("memos")
        .select("id, title")
        .order("updated_at", { ascending: false });
      if (fetchError) throw new Error(fetchError.message);

      if (!data || data.length === 0) {
        addAssistantMessage("編集できるメモがまだありません。");
        return;
      }

      setEditFlow({ step: "choosing", options: data });
      addAssistantMessage(
        `編集したいメモを選んでください(番号か、タイトルの一部を入力してください)\n\n${formatOptionList(data)}`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "メモ一覧の取得に失敗しました");
    } finally {
      setStatus(null);
    }
  }

  function resolveSelection(text: string, options: MemoOption[]) {
    const trimmed = text.trim();
    const asNumber = Number(trimmed);
    if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= options.length) {
      return { matches: [options[asNumber - 1]] };
    }
    const keyword = trimmed.toLowerCase();
    const matches = options.filter((o) => o.title.toLowerCase().includes(keyword));
    return { matches };
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text || loading) return;

    if (editFlow.step === "choosing") {
      setMessages((prev) => [...prev, { role: "user", content: text }]);
      setInput("");

      const { matches } = resolveSelection(text, editFlow.options);
      if (matches.length === 1) {
        const target = matches[0];
        setEditFlow({ step: "editing", target });
        addAssistantMessage(
          `「${target.title}」を編集しますね。どう変更しますか?`,
        );
      } else if (matches.length > 1) {
        setEditFlow({ step: "choosing", options: matches });
        addAssistantMessage(
          `候補が複数見つかりました。番号かタイトルでもう少し絞り込んでください\n\n${formatOptionList(matches)}`,
        );
      } else {
        addAssistantMessage(
          `見つかりませんでした。番号かタイトルの一部で入力してください\n\n${formatOptionList(editFlow.options)}`,
        );
      }
      return;
    }

    if (editFlow.step === "editing") {
      const target = editFlow.target;
      setEditFlow({ step: "idle" });
      await callChatApi(
        text,
        `${text}\n\n(対象メモ: 「${target.title}」 / id=${target.id})`,
      );
      return;
    }

    await callChatApi(text, text);
  }

  return (
    <div className="flex h-[70vh] flex-col rounded-xl border border-zinc-200 bg-white">
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 && (
          <p className="text-sm text-zinc-400">
            下のボタンか、メッセージ入力で話しかけてみてください。
          </p>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-2 text-sm ${
                m.role === "user"
                  ? "bg-zinc-900 text-white"
                  : "bg-zinc-100 text-zinc-900"
              }`}
            >
              {m.content}
            </div>
          </div>
        ))}
        {status && (
          <div className="flex justify-start">
            <div className="flex items-center gap-2 rounded-2xl bg-zinc-100 px-4 py-2 text-sm text-zinc-500">
              <TypingDots />
              {status}
            </div>
          </div>
        )}
        {error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
            {error}
          </p>
        )}
      </div>

      <div className="flex gap-2 border-t border-zinc-200 px-3 pt-3">
        <button
          type="button"
          onClick={handleShowMemos}
          disabled={loading}
          className="rounded-full border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
        >
          📋 メモを見せて
        </button>
        <button
          type="button"
          onClick={handleStartEdit}
          disabled={loading}
          className="rounded-full border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
        >
          ✏️ メモを編集する
        </button>
      </div>

      <form onSubmit={handleSubmit} className="flex gap-2 p-3">
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={
            editFlow.step === "choosing"
              ? "番号かタイトルを入力"
              : editFlow.step === "editing"
                ? "どう変更するか入力"
                : "メッセージを入力"
          }
          className="flex-1 rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-400"
        />
        <button
          type="submit"
          disabled={loading}
          className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          送信
        </button>
      </form>
    </div>
  );
}
