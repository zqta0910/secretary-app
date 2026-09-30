-- Supabase SQL Editor で実行してください。
-- 会議議事録のRAG(意味検索)機能用のテーブルと関数です。

create extension if not exists vector;

create table if not exists public.meeting_minutes_chunks (
  id uuid primary key default gen_random_uuid(),
  meeting_title text not null,
  meeting_date date not null,
  chunk_index int not null,
  content text not null,
  embedding vector(1024) not null,
  source_file text,
  created_at timestamptz not null default now()
);

-- 今回のデータ量(数百行程度)ではHNSWインデックスがなくても十分速いですが、
-- 学習目的も兼ねて、モデルインデックスとして作成しておきます。
create index if not exists meeting_minutes_chunks_embedding_idx
  on public.meeting_minutes_chunks
  using hnsw (embedding vector_cosine_ops);

alter table public.meeting_minutes_chunks enable row level security;

-- 読み取り(SELECT)のみ anon/authenticated に許可します。
-- 書き込み(INSERT/UPDATE/DELETE)のポリシーはあえて作りません。
-- データ投入は service_role キー(RLSを無視する特別な鍵)を使う
-- scripts/ingest-meeting-minutes.mjs からのみ行う設計のためです。
drop policy if exists "Allow public select" on public.meeting_minutes_chunks;

create policy "Allow public select"
on public.meeting_minutes_chunks
for select
to anon, authenticated
using (true);

grant select on table public.meeting_minutes_chunks to anon, authenticated;

-- 意味検索用の関数。しきい値・件数・期間で絞り込んだ結果を、類似度が高い順に返します。
create or replace function public.match_meeting_minutes(
  query_embedding vector(1024),
  match_threshold float default 0.5,
  match_count int default 5,
  date_from date default null,
  date_to date default null
)
returns table (
  id uuid,
  meeting_title text,
  meeting_date date,
  chunk_index int,
  content text,
  similarity float
)
language sql
stable
as $$
  select
    id,
    meeting_title,
    meeting_date,
    chunk_index,
    content,
    1 - (embedding <=> query_embedding) as similarity
  from public.meeting_minutes_chunks
  where 1 - (embedding <=> query_embedding) > match_threshold
    and (date_from is null or meeting_date >= date_from)
    and (date_to is null or meeting_date <= date_to)
  order by embedding <=> query_embedding
  limit match_count
$$;

grant execute on function public.match_meeting_minutes(vector, float, int, date, date) to anon, authenticated;
