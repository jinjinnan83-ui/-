# 数据库说明（师友伴）

本目录提供 **PostgreSQL** 脚本，推荐在 [Supabase](https://supabase.com) 上托管（免费层即可），与你的 Netlify 静态站搭配使用。

## 1. 创建 Supabase 项目

1. 登录 Supabase，新建 Project，记下 **Project URL** 和 **anon public** API Key（设置 -> API）。

2. 在左侧 **SQL Editor** 新建查询，把 `supabase.sql` **完整粘贴**后执行一次。

3. 若某几行报错（例如 `auth.users` 上建触发器权限、`realtime publication` 已存在），可把对应段落单独注释后再执行；核心表与 RPC 成功即可。

## 2. 表与流程说明

| 表 / 对象 | 作用 |
|-----------|------|
| `profiles` | 与 `auth.users` 绑定的公开资料（昵称等） |
| `orders` | 陪诊订单：发布人、医院、性别偏好、标签、金额（分）、备注、状态 |
| `take_order(uuid)` | 抢单：`open` → `taken`，原子更新避免并发抢同一单 |
| `confirm_order(uuid)` | 锁单：`taken` → `locked`（仅接单人） |
| `release_order(uuid)` | 不合适放回大厅：`taken` → `open`（仅接单人） |

**状态约定：** `open`（大厅可见） → `taken`（沟通中） → `locked`（已确认） / `cancelled`（发布人取消）

金额字段为 **`price_cents`（整数分）**，避免小数误差。

## 3. 前端对接（概念）

- 使用 **Supabase Auth** 登录后，客户端用 **anon key** + JS SDK，在 **Row Level Security** 策略下调用：
  - `insert` 一条 `orders`（`publisher_id` 必须为当前用户，脚本已约束）
  - `select` 拉取 `status = open` 的大厅列表
  - `rpc('take_order', { p_order_id: '...' })` 接单

**不要在公开仓库提交 service_role key**；**anon key** 可放在前端，真正权限由 RLS 与 RPC 保证。

## 4. Realtime

脚本中已尝试把 `orders` 加入 `supabase_realtime` 发布。若执行报错，可在 Dashboard -> Database -> Replication 中手动勾选 `public.orders`。

---

更细的字段含义以 `supabase.sql` 内注释为准。
