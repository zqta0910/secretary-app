import ChatApp from "@/components/ChatApp";

export default function Home() {
  return (
    <div className="min-h-full bg-zinc-100">
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10 sm:px-6">
        <header>
          <p className="text-sm font-medium tracking-wide text-zinc-500">
            Next.js + Supabase + Claude API
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-zinc-950">
            秘書AI
          </h1>
        </header>
        <ChatApp />
      </main>
    </div>
  );
}
