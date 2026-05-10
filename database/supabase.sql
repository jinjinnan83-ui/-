-- 师友伴：订单发布 / 接单（Supabase / PostgreSQL）
-- 在 Supabase 控制台 -> SQL Editor 中整段执行一次即可。

-- 可选：若项目未启用 pgcrypto，可打开（Supabase 多数项目已可用 gen_random_uuid）
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 用户扩展表（与 auth.users 一对一）
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- 新用户注册时自动建 profile（需在 Dashboard 里为 auth.users 建触发器，见文末说明）
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ---------------------------------------------------------------------------
-- 订单
-- ---------------------------------------------------------------------------
-- 重复执行脚本时 enum 可能已存在，忽略「已存在」错误即可
do $$
begin
  create type public.order_status as enum ('open', 'taken', 'locked', 'cancelled');
exception
  when duplicate_object then null;
end $$;

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  publisher_id uuid not null references public.profiles (id) on delete cascade,
  hospital text not null,
  gender_pref text not null,
  tags text[] not null default '{}',
  price_cents integer not null check (price_cents > 0),
  note text,
  status public.order_status not null default 'open',
  taker_id uuid references public.profiles (id) on delete set null,
  taken_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists orders_open_created_idx
  on public.orders (created_at desc)
  where status = 'open';

create index if not exists orders_publisher_idx on public.orders (publisher_id);
create index if not exists orders_taker_idx on public.orders (taker_id);

alter table public.orders enable row level security;

create or replace function public.set_orders_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists orders_set_updated_at on public.orders;
create trigger orders_set_updated_at
  before update on public.orders
  for each row execute procedure public.set_orders_updated_at();

-- ---------------------------------------------------------------------------
-- 行级安全策略（重复执行时先删再建）
-- ---------------------------------------------------------------------------

drop policy if exists profiles_select_own on public.profiles;
drop policy if exists profiles_update_own on public.profiles;
drop policy if exists profiles_insert_own on public.profiles;
drop policy if exists orders_select_visible on public.orders;
drop policy if exists orders_insert_publisher on public.orders;
drop policy if exists orders_cancel_by_publisher on public.orders;

-- profiles：本人可读可改自己的资料
create policy profiles_select_own
  on public.profiles for select
  to authenticated
  using (id = auth.uid());

create policy profiles_update_own
  on public.profiles for update
  to authenticated
  using (id = auth.uid());

-- 允许用户为自己创建 profile（若下方 auth 触发器未生效，可在前端补一次 insert）
create policy profiles_insert_own
  on public.profiles for insert
  to authenticated
  with check (id = auth.uid());

-- orders：大厅里「open」对所有人可见；与自己相关的单始终可见
create policy orders_select_visible
  on public.orders for select
  to authenticated
  using (
    status = 'open'
    or publisher_id = auth.uid()
    or taker_id = auth.uid()
  );

-- 发布订单：只能以自己为发布人
create policy orders_insert_publisher
  on public.orders for insert
  to authenticated
  with check (publisher_id = auth.uid());

-- 发布人可取消自己的待接单（open -> cancelled）
create policy orders_cancel_by_publisher
  on public.orders for update
  to authenticated
  using (publisher_id = auth.uid() and status = 'open')
  with check (status = 'cancelled');

-- 其余状态流转由下方 RPC 函数完成，避免并发抢单竞态

-- ---------------------------------------------------------------------------
-- 接单 / 锁单（安全定义函数，统一写状态）
-- ---------------------------------------------------------------------------

-- 抢单：仅当 status=open，原子更新为 taken 并记录接单者
create or replace function public.take_order(p_order_id uuid)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.orders;
  v_cnt integer;
begin
  if auth.uid() is null then
    raise exception '需要登录';
  end if;

  update public.orders o
  set
    status = 'taken'::public.order_status,
    taker_id = auth.uid(),
    taken_at = now()
  where o.id = p_order_id
    and o.status = 'open'::public.order_status
    and o.publisher_id <> auth.uid();

  get diagnostics v_cnt = row_count;
  if v_cnt = 0 then
    raise exception '订单不可接单（可能已被接走、已取消或是自己发布的）';
  end if;

  select * into v_row from public.orders where id = p_order_id;
  return v_row;
end;
$$;

revoke all on function public.take_order(uuid) from public;
grant execute on function public.take_order(uuid) to authenticated;

-- 确认陪同（锁单）：仅接单者可执行，taken -> locked
create or replace function public.confirm_order(p_order_id uuid)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.orders;
  v_cnt integer;
begin
  if auth.uid() is null then
    raise exception '需要登录';
  end if;

  update public.orders o
  set status = 'locked'::public.order_status
  where o.id = p_order_id
    and o.status = 'taken'::public.order_status
    and o.taker_id = auth.uid();

  get diagnostics v_cnt = row_count;
  if v_cnt = 0 then
    raise exception '无权确认或状态不是待确认';
  end if;

  select * into v_row from public.orders where id = p_order_id;
  return v_row;
end;
$$;

revoke all on function public.confirm_order(uuid) from public;
grant execute on function public.confirm_order(uuid) to authenticated;

-- 释放订单（接单方不合适）：taken -> open，清空接单人
create or replace function public.release_order(p_order_id uuid)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.orders;
  v_cnt integer;
begin
  if auth.uid() is null then
    raise exception '需要登录';
  end if;

  update public.orders o
  set
    status = 'open'::public.order_status,
    taker_id = null,
    taken_at = null
  where o.id = p_order_id
    and o.status = 'taken'::public.order_status
    and o.taker_id = auth.uid();

  get diagnostics v_cnt = row_count;
  if v_cnt = 0 then
    raise exception '无权释放或状态不是沟通中';
  end if;

  select * into v_row from public.orders where id = p_order_id;
  return v_row;
end;
$$;

revoke all on function public.release_order(uuid) from public;
grant execute on function public.release_order(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime：大厅列表可订阅 orders 变更（在 Dashboard 中也可手动勾选表）
-- ---------------------------------------------------------------------------
do $$
begin
  alter publication supabase_realtime add table public.orders;
exception
  when duplicate_object then null;
end $$;
