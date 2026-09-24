import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

function isPlaceholder(value: string | undefined) {
  if (!value) return true;
  return (
    value.includes("your-project") ||
    value.includes("your-anon-key") ||
    value.includes("your-project-ref")
  );
}

export const isSupabaseConfigured = Boolean(
  supabaseUrl &&
    supabaseAnonKey &&
    !isPlaceholder(supabaseUrl) &&
    !isPlaceholder(supabaseAnonKey),
);

export function getSupabase() {
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      "Supabase の環境変数が未設定です。`.env.local` に NEXT_PUBLIC_SUPABASE_URL と NEXT_PUBLIC_SUPABASE_ANON_KEY を追加してください。",
    );
  }

  return createClient(supabaseUrl, supabaseAnonKey);
}
