-- ============================================================================
-- 师友伴：答题登录版数据库迁移（Supabase / PostgreSQL）
-- 在 Supabase 控制台 -> SQL Editor 中整段执行。
-- 可重复执行，兼容已有数据库。
-- ============================================================================

-- 可选：启用 pgcrypto（Supabase 多数项目已可用 gen_random_uuid）
create extension if not exists pgcrypto;

-- ============================================================================
-- 1. 移除对 auth.users 的依赖
-- ============================================================================

-- 删除旧的触发器（依赖 auth.users）
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();

-- profiles: 解除与 auth.users 的外键约束
do $$
begin
  if exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'profiles_id_fkey'
    and table_name = 'profiles'
  ) then
    alter table public.profiles drop constraint profiles_id_fkey;
  end if;
end $$;

-- profiles: 如果表不存在则创建（迁移场景下更新约束）
create table if not exists public.profiles (
  id uuid primary key,
  display_name text,
  created_at timestamptz not null default now()
);

-- orders: 如果表已存在，增加 publisher_name 列并调整外键
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'orders' and column_name = 'publisher_name'
  ) then
    alter table public.orders add column publisher_name text;
  end if;
end $$;

-- 解除 orders 与 auth.users 的间接依赖（profiles 不再关联 auth.users）
do $$
begin
  if exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'orders_publisher_id_fkey'
    and table_name = 'orders'
  ) then
    alter table public.orders drop constraint orders_publisher_id_fkey;
  end if;
  if exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'orders_taker_id_fkey'
    and table_name = 'orders'
  ) then
    alter table public.orders drop constraint orders_taker_id_fkey;
  end if;
end $$;

-- ============================================================================
-- 2. 订单表（初次创建时）
-- ============================================================================

-- 确保 enum 类型存在
do $$
begin
  create type public.order_status as enum ('open', 'taken', 'locked', 'cancelled');
exception
  when duplicate_object then null;
end $$;

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  publisher_id uuid not null,
  publisher_name text,
  hospital text not null,
  gender_pref text not null,
  tags text[] not null default '{}',
  price_cents integer not null check (price_cents > 0),
  note text,
  status public.order_status not null default 'open',
  taker_id uuid,
  taken_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists orders_open_created_idx
  on public.orders (created_at desc)
  where status = 'open';

create index if not exists orders_publisher_idx on public.orders (publisher_id);
create index if not exists orders_taker_idx on public.orders (taker_id);

-- 自动更新 updated_at
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

-- ============================================================================
-- 3. 行级安全策略 — 关闭 RLS（答题登录无 auth.uid()，由前端自行校验）
-- ============================================================================

alter table public.profiles disable row level security;
alter table public.orders disable row level security;

-- 删除旧的 RLS 策略（已无用）
drop policy if exists profiles_select_own on public.profiles;
drop policy if exists profiles_update_own on public.profiles;
drop policy if exists profiles_insert_own on public.profiles;
drop policy if exists orders_select_visible on public.orders;
drop policy if exists orders_insert_publisher on public.orders;
drop policy if exists orders_cancel_by_publisher on public.orders;

-- ============================================================================
-- 4. RPC 函数：接受 p_user_id 参数，不再依赖 auth.uid()
-- ============================================================================

-- 删除旧版函数
drop function if exists public.take_order(uuid);
drop function if exists public.confirm_order(uuid);
drop function if exists public.release_order(uuid);

-- 抢单
create or replace function public.take_order(p_order_id uuid, p_user_id uuid)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.orders;
  v_cnt integer;
begin
  if p_user_id is null then
    raise exception '需要提供用户ID';
  end if;

  update public.orders o
  set
    status = 'taken'::public.order_status,
    taker_id = p_user_id,
    taken_at = now()
  where o.id = p_order_id
    and o.status = 'open'::public.order_status
    and o.publisher_id <> p_user_id;

  get diagnostics v_cnt = row_count;
  if v_cnt = 0 then
    raise exception '订单不可接单（可能已被接走、已取消或是自己发布的）';
  end if;

  select * into v_row from public.orders where id = p_order_id;
  return v_row;
end;
$$;

revoke all on function public.take_order(uuid, uuid) from public;
grant execute on function public.take_order(uuid, uuid) to anon, authenticated;

-- 确认陪同（锁单）
create or replace function public.confirm_order(p_order_id uuid, p_user_id uuid)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.orders;
  v_cnt integer;
begin
  if p_user_id is null then
    raise exception '需要提供用户ID';
  end if;

  update public.orders o
  set status = 'locked'::public.order_status
  where o.id = p_order_id
    and o.status = 'taken'::public.order_status
    and o.taker_id = p_user_id;

  get diagnostics v_cnt = row_count;
  if v_cnt = 0 then
    raise exception '无权确认或状态不是待确认';
  end if;

  select * into v_row from public.orders where id = p_order_id;
  return v_row;
end;
$$;

revoke all on function public.confirm_order(uuid, uuid) from public;
grant execute on function public.confirm_order(uuid, uuid) to anon, authenticated;

-- 释放订单
create or replace function public.release_order(p_order_id uuid, p_user_id uuid)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.orders;
  v_cnt integer;
begin
  if p_user_id is null then
    raise exception '需要提供用户ID';
  end if;

  update public.orders o
  set
    status = 'open'::public.order_status,
    taker_id = null,
    taken_at = null
  where o.id = p_order_id
    and o.status = 'taken'::public.order_status
    and o.taker_id = p_user_id;

  get diagnostics v_cnt = row_count;
  if v_cnt = 0 then
    raise exception '无权释放或状态不是沟通中';
  end if;

  select * into v_row from public.orders where id = p_order_id;
  return v_row;
end;
$$;

revoke all on function public.release_order(uuid, uuid) from public;
grant execute on function public.release_order(uuid, uuid) to anon, authenticated;

-- ============================================================================
-- 5. Realtime：大厅列表可订阅 orders 变更
-- ============================================================================
do $$
begin
  alter publication supabase_realtime add table public.orders;
exception
  when duplicate_object then null;
end $$;
