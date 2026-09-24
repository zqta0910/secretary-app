export type Memo = {
  id: string;
  title: string;
  body: string;
  important: boolean;
  created_at: string;
  updated_at: string;
};

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};
