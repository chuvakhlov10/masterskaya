-- Выполни этот SQL в Supabase → SQL Editor → New query → Run

create table if not exists kv_store (
  key text primary key,
  value jsonb not null,
  updated_at timestamp with time zone default now()
);

-- Разрешить чтение и запись без авторизации (anon key достаточно)
alter table kv_store enable row level security;

create policy "allow all" on kv_store
  for all using (true) with check (true);
