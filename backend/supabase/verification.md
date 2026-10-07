# 回执验证方案

运行 SQL 或单元测试只证明数据库逻辑，不能代替真实 Supabase Auth、PostgREST、WebSocket 或国内网络验收。测试数据使用明显的 `TEST-` 姓名，验证后仅由可信后台清理本次测试创建的记录；不要清空真实数据。

## 可单独运行的数据库测试

SQL 测试应在专用的 PostgreSQL 15+ UTF-8 测试数据库或新建的 Supabase 测试项目中执行。纯 PostgreSQL 需先准备 `anon`、`authenticated` 角色，模拟 `auth.uid()`、`auth.jwt()` 从 `request.jwt.claims` 读取身份，再运行 `schema.sql`。不要把模拟 Auth 函数部署到 Supabase 生产项目。真实 SQL 测试入口为 `../tests/supabase-sql.test.cjs`，它在独立 PGlite PostgreSQL 引擎中执行完整 schema 原文，包含 publication，不替换业务函数。

在仓库根目录单独运行（依赖只安装到临时目录）：

```sh
WEDDING_SQL_TEST_DIR="$(mktemp -d)"
npm install --prefix "$WEDDING_SQL_TEST_DIR" @electric-sql/pglite@0.5.8
WEDDING_PGLITE_MODULE="$WEDDING_SQL_TEST_DIR/node_modules/@electric-sql/pglite" node --test backend/tests/supabase-sql.test.cjs
```

没有安装引擎时，测试入口会标记 skipped；skipped 不能作为通过证据。PGlite 的单连接测试不能证明真实多连接锁隔离或 Supabase WebSocket/Auth 行为。

在专用测试数据库内，超级用户可使用 `set_config('request.jwt.claims', ..., true)` 和 `SET LOCAL ROLE authenticated` 模拟可信服务端验证后的 JWT；这只用于测试。宾客浏览器不能设置数据库角色或任意 JWT claims。

必要断言：

1. 缺少可信 UID、空姓名、41 个字符、内部控制字符、非法 UUID、人数 0/21/非整数、无效版本均被拒绝，不新增回执、操作或限流计数；NFC 和 Unicode 首尾空白被规范化。
2. 首次提交返回完整 camelCase receipt；修改更新同一 id，createdAt 不变；同名的不同 UID 保留两行。
3. 同一 operationId 连续重试 25 次只产生一条操作和一次限流计数；同 ID 改 payload/version 返回 ID_CONFLICT。
4. 新操作更新为新人数后重试旧成功操作返回当前最新回执；从未处理过的低版本操作返回 STALE_OPERATION，数据库保持最新人数。
5. 不同 UID 使用已占用的 submissionId 返回 ID_CONFLICT，原记录的 owner/name/people 不变。
6. 一分钟第 11 个新操作返回 RATE_LIMITED；已成功操作仍可重试。将测试限流 bucket 设置成上一分钟后，新操作恢复可用。
7. 游客直接 SELECT 看不到名单，直接写表或读取 private 表被拒绝；游客调用 list/authorize 返回 FORBIDDEN。未配置管理员、错误 UID、相同 UID 的匿名 JWT 均拒绝读取。
8. 配置专用永久管理员后，authorize 成功，SELECT RLS 只向该管理员开放；205 条记录分页恰好读取 205 个不同 id，正确累加人数，最后 nextCursor=null。非法 cursor 和 p_limit>100 被拒绝。
9. 模拟操作凭证写入失败，证明回执和限流一起回滚。真实 PostgreSQL 使用至少两个并发连接提交相同 UID 的首次记录，验证 advisory lock 和唯一约束；单连接/WASM 环境不能证明并发隔离。
10. `pg_publication_tables` 包含 wedding_rsvps，公开角色没有直接 DML 权限，private 表无公开权限，security definer 函数 search_path 为空。schema 重跑后记录保留。

## 实际服务验收

1. 新的浏览器身份通过 signInAnonymously 得到真实 JWT；匿名 RPC 保存 TEST 回执，成功 receipt 与数据库记录一致，刷新/重开管理页仍存在。
2. 不带 JWT 的 REST 请求不能提交或读名单；持游客 JWT 的 REST SELECT 结果为空，list/authorize RPC 返回 FORBIDDEN；篡改 adminUid、ownerUid 或 JWT 内容不能获得权限。
3. 两个浏览器：管理页已登录并显示数据，访客提交后管理页收到真实 realtime 事件并更新人数。修改、网络中断重连和重新进入页面也重新读取，不显示过时“已同步”。
4. 管理页退出后不再显示名单；宾客页面与管理页独立 storageKey，访问请帖不会复用管理员会话。
5. 具体 `.supabase.co` 端点在当前机器禁用代理的情况下完成实际 HTTPS 调用；再由国内手机蜂窝/Wi-Fi 完成提交。只有本机直连时不要声称“所有国内网络都验证通过”。
6. 客户端和公开仓库只包含项目 URL、公钥及无需保密的函数名称，不包含 service-role、secret、管理员密码或管理 API token。
7. 完成后记录项目、部署时间、测试 receipt id、实际结果与尚未验证范围；本地测试通过不能写成已部署。
