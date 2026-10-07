# 婚礼回执后端：Supabase

请帖继续放在 GitHub Pages。此目录只负责回执的持久保存、管理员访问控制和实时通知，不使用腾讯云。

## 部署顺序

1. 在独立的 Supabase 免费组织中新建项目，区域选新加坡 `ap-southeast-1`。开通页面显示 Free 后再创建；不切换付费计划。免费项目可能因低活跃暂停，见后文。
2. 在 SQL Editor 中以 `postgres` 运行完整 `schema.sql`。文件使用事务，可重跑，不清空已有数据。它专用于新建的婚礼项目，不应与其他应用共用同名表或 `private` schema。
3. 在 Authentication 设置中启用 **Anonymous Sign-Ins**，保持 Email/Password 登录可用。宾客首次提交时建立匿名身份，无需姓名以外的账号信息。
4. 用可信服务端 `auth.admin.createUser` 或控制台创建一个专用管理员 Email/Password 用户，并确认邮箱。密码只通过私密方式交付，不能放入页面、GitHub、SQL 模板或日志。不要对外提供永久账号注册界面。
5. 从 Auth 用户列表取得管理员 UUID，将其代入 `configure-admin.sql.template`，在 SQL Editor 执行。填好的版本不要提交到 GitHub。没有此设置时，管理员读取默认拒绝。
6. 前端只配置 Supabase 项目 URL 和 **publishable / anon 公钥**，并适配下面的 RPC。service-role / secret key、数据库密码、管理 API token 均不能用于浏览器。`private` schema 必须保持不在 API 的 Exposed schemas 中。
7. 登录管理页后先调用 `authorize_wedding_admin()`，再读取全部分页，并订阅 `public.wedding_rsvps` 的 INSERT/UPDATE。事件只用于触发刷新；人数以重新读取成功的数据为准。断线重连和切回前台后也重新读取。
8. 完成实际 API 验证，再宣布服务开通。至少测试国内无代理提交、持久化、管理员实时更新以及未授权名单读取拒绝，见 `verification.md`。

当前 Supabase 新表需要显式 Data API 权限；此文件已经包含必要的 `GRANT`。Realtime publication 也已经配置。管理员的 SELECT RLS 策略同时决定是否能收到变更事件。

## 本地部署辅助脚本

`deploy.mjs` 使用官方 Management API 和 Auth Admin API，只有 `list`、`prepare`、`deploy` 三步。Node.js 20+ 即可，无需安装运行依赖。`prepare` / `deploy` 默认离线 dry-run：不会读取凭据、联网、生成密码或修改文件；只有明确添加 `--apply` 才实际执行。`list` 是实际只读 API 调用。

```sh
# 无凭据也能查看具体执行计划。
node backend/supabase/deploy.mjs prepare --org FREE_ORG_SLUG --name wedding-rsvp --create
node backend/supabase/deploy.mjs deploy --org FREE_ORG_SLUG --admin-email YOUR_ADMIN_EMAIL

# 以下动作须在真实平台登录和本次任务授权已经成立后执行。
node backend/supabase/deploy.mjs list --token-file /ABSOLUTE/PATH/TO/PROTECTED_TOKEN_FILE
node backend/supabase/deploy.mjs prepare --org FREE_ORG_SLUG --name wedding-rsvp --create --apply --token-file /ABSOLUTE/PATH/TO/PROTECTED_TOKEN_FILE
node backend/supabase/deploy.mjs deploy --org FREE_ORG_SLUG --admin-email YOUR_ADMIN_EMAIL --apply --token-file /ABSOLUTE/PATH/TO/PROTECTED_TOKEN_FILE

# 完全本地的 mock API 检查，不访问真实云资源。
node --test backend/supabase/deploy.test.mjs
```

管理 token 只能通过 `SUPABASE_ACCESS_TOKEN` 环境变量或当前用户拥有的 0600 凭据文件读取，不能把 token/密码值放在 CLI 参数、公开文件或工具输出。文件可为纯 token，或包含 `access_token` / `SUPABASE_ACCESS_TOKEN` / `token` 字段的 JSON。脚本不会显示原始 provider 响应或异常堆栈。

`prepare --create --apply` 先核实指定组织的 `plan` 明确为 `free`，检查项目列表与新加坡可用性，再创建一个最小默认规格项目。脚本不创建/升级组织，不改套餐，不删除资源，不自动采用名称相同但没有本地创建凭证的未知项目。项目刚创建时可能尚未 `ACTIVE_HEALTHY`，稍后检查状态再执行 deploy；脚本不会在后台持续等待。

创建意图、数据库密码、项目 ref 和生成的专用管理员密码只保存在被此目录 `.gitignore` 忽略的 `local-secrets/deployment.json`（目录 0700、文件 0600）；管理 token 不会复制进去。创建请求结果未知时，下一次 prepare 只列举和核对符合原意图的项目，不能自动重建。管理员创建结果未知时，下一次 deploy 核对对应邮箱并验证原先保存的密码，不会创建第二个账号或重置未知账号密码。

deploy 只处理此脚本已创建且仍属于相同 Free 组织、新加坡区的项目，拒绝无关 public/private 表及未登记的管理员设置；完整 schema 成功后启用匿名 Auth，将新匿名账号的 IP 小时限额设为 300，创建命令明确指定的永久管理员，并绑定私有 UID。最后生成 `data/backend.json`，仅含项目 URL、公钥和公开的 provider/轮询设置。已指向其他项目的公开配置不会被覆盖。密码供用户通过受保护本地文件私密查看，脚本不会自动发消息或打印密码。

脚本输出“deployed”只说明上述 API 配置步骤完成，不能代替实际提交、私密管理员登录、Realtime 和国内网络验收。缺少平台授权时保持公开配置为空，不应宣称线上回执可用。

## RPC 契约

所有 RPC 返回一个 JSON 对象，不返回数组。SQL 自定义错误的 `message` 是稳定代码，前端将其映射为中文提示，不能直接展示原始数据库错误。

```js
supabase.rpc('submit_wedding_rsvp', {
  p_name: '示例宾客',
  p_people: 3,
  p_submission_id: '浏览器持久保存的 UUID',
  p_operation_id: '当前一次编辑对应的 UUID',
  p_client_version: 1791350000000
})
// => { id, name, people, createdAt, submittedAt }

supabase.rpc('authorize_wedding_admin')
// => { authorized: true }

supabase.rpc('list_wedding_rsvps', { p_cursor: null, p_limit: 100 })
// => { rows: [{ id, name, people, createdAt, submittedAt }], nextCursor, fetchedAt }
```

- `id` 是数据库记录 UUID；时间字段为 UTC ISO 8601 字符串，形如 `2026-10-07T05:00:00.000Z`。
- `submissionId` 在同一浏览器保持稳定；每个可信 Auth UID 只有一份当前回执，重新提交会更新人数。姓名相同的不同宾客保留各自记录。
- 新编辑产生新的 `operationId` 和单调递增 `clientVersion = Math.max(Date.now(), previousVersion + 1)`，并一起持久保存；相同编辑重试必须复用二者。
- 同一 UID、同一 operationId、相同标准化内容和版本的重试返回**当前最新回执**，不再写入、不消耗限流额度；不能重放旧修改覆盖新回执。同一个 operationId 换内容或版本返回 `ID_CONFLICT`。
- 从未成功处理过但版本低于或等于当前记录的迟到请求返回 `STALE_OPERATION`，不会覆盖新记录。前端保留填写内容并提示重新提交，不应将错误伪装为成功。
- `p_cursor` 是上一页的 `nextCursor`，不能按页码自行生成。每页上限 100；最后一页 `nextCursor` 为 null。
- 访客没有 INSERT/UPDATE/DELETE 表权限，仅通过检查 Auth 身份的事务 RPC 写入；游客直接 SELECT 返回空集合，未登录的 `anon` 角色没有读取权限。管理员也只拥有直接 SELECT，不能通过此页面改删宾客数据。

错误代码：`UNAUTHENTICATED`、`INVALID_NAME`、`INVALID_PEOPLE`、`INVALID_ID`、`ID_CONFLICT`、`STALE_OPERATION`、`RATE_LIMITED`、`FORBIDDEN`、`INVALID_CURSOR`、`INCONSISTENT_DATA`。错误的 JSON 类型、UUID 或整数在数据库参数转换阶段也可能触发 PostgREST 错误；前端应统一显示输入无效，不展示 SQL 内容。

## 身份、限流和持久化边界

姓名为标准化后的 1–40 个 Unicode 字符，不能包含内部控制字符；用餐人数为 1–20 位。每个 Auth UID 每个自然分钟最多接受 10 个新操作。记录、操作幂等凭证及限流计数在同一 SQL 事务内写入；任何失败均回滚。独立 UID 锁防止首次提交和并发修改出现多份记录，数据库唯一约束防止冒用别人的 submissionId。

Supabase 匿名注册另有平台 IP 限流，当前默认每 IP 每小时 30 个匿名注册；同一 Wi-Fi 下集中提交可能受到这一限制，应在上线前检查实际场景，并按真实宾客规模设置。SQL 的 UID 限流不是机器人全面防护，不应宣称可防分布式刷量；如出现滥用，启用平台支持的验证码并让前端携带相应 token。

清空浏览器、换设备或退出匿名身份会失去原有回执的修改身份，新的匿名身份可以新建回执。它不是可靠的“按人去重”，后台会保留同名记录，供新人核对。未在表上设置指向 `auth.users` 的级联删除，清理匿名账户不会删除已保存的婚宴统计。

管理员凭证与宾客会话须使用独立的 SDK `storageKey`；访客页面不应自动使用管理页保存的账号。关闭匿名 Sign-Ins 会使新宾客无法提交。不要清理操作凭证，否则历史重试的幂等性会改变。

## 免费项目维护

当前 Free 提供每项目 500 MB 数据库、每月 200 万实时消息和 200 个实时连接，足够一般婚宴回执。但低活跃免费项目可能在约 7 天后被暂停，免费方案没有生产 SLA。项目暂停后需控制台恢复，不能把功能上线说成永久免维护。发布期应通过实际管理查看确认服务正常，婚礼后及时导出 CSV 备份。创建任何付费资源或升级套餐需要另行取得用户授权。

新加坡位置不能证明国内一定可达。验收必须访问具体项目 API 端点，使用无代理环境，并明确区分本机直连测试和不同国内网络的实测。

## 官方依据

- [Anonymous Sign-Ins](https://supabase.com/docs/guides/auth/auth-anonymous)：匿名用户也使用 authenticated 数据库角色；身份丢失及匿名注册限流。
- [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)：按 JWT/Auth UID 实施数据权限。
- [新表 Data API 权限变更](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically)：新表必须显式 GRANT。
- [Realtime 排查](https://supabase.com/docs/guides/troubleshooting/realtime-postgres-changes-troubleshooting)：publication 与 SELECT RLS 均决定事件可见性。
- [API keys](https://supabase.com/docs/guides/getting-started/api-keys)：浏览器公钥与服务端密钥的边界。
- [Free 计费](https://supabase.com/docs/guides/platform/billing-on-supabase)和[暂停规则](https://supabase.com/docs/guides/platform/free-project-pausing)：免费额度与维护限制。
- [组织信息](https://supabase.com/docs/reference/api/v1-get-an-organization)、[创建项目](https://supabase.com/docs/reference/api/v1-create-a-project)、[Auth 配置](https://supabase.com/docs/reference/api/v1-update-auth-service-config)、[项目 API keys](https://supabase.com/docs/reference/api/v1-get-project-api-keys)、[创建管理员](https://supabase.com/docs/reference/javascript/auth-admin-createuser)：部署脚本所用的官方接口。当前匿名 Auth 字段以 [官方 OpenAPI](https://github.com/supabase/supabase/blob/master/apps/docs/spec/api_v1_openapi.json) 的 `external_anonymous_users_enabled` 和 `rate_limit_anonymous_users` 为准。

## 只读运行检查

`service-health.sql` 是独立迁移，由部署者在主 schema 之后执行；是否完成云端执行应以实际 API 验证记录为准。
它增加 `public.wedding_service_health()`，仅返回 `{ok:true,checkedAt:UTC时间}`，不访问或修改回执、用户、人数和管理设置。
函数使用调用者权限，移除默认 PUBLIC 执行权限，仅向 anon/authenticated 明确授予执行权限，不扩大表读取/写入权限。

Deno 中转的 `runtime.ts` 使用公开 publishable key 每 6 小时查询该接口。检查无需管理 PAT 或管理员账户，
可降低 Free 项目长期低活动暂停风险；仍需确认迁移完成、Deno 计划任务发现及执行成功。详细运行边界见
`backend/deno-proxy/README.md`。免费计划没有永久可用保证。
