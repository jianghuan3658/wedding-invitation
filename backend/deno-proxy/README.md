# 请帖回执固定中转

这是 Deno 原生 HTTP / WebSocket 服务，无第三方依赖、无环境密钥。固定上游是本请帖的
`xnqgblzvcltiomqfecsn.supabase.co`，不能通过 URL、请求体或环境变量选择别的目标。

包含定时维护的部署入口为 `backend/deno-proxy/runtime.ts`，运行时 Deno 2，启用 `--unstable-cron`。 `main.ts`
是可独立测试的代理逻辑；运行它或只加载其默认 `fetch` 导出不会注册维护任务。
这里仅提供可审查源码，仓库文件不代表已经上线。

本地离线验证：

```sh
deno check backend/deno-proxy/main.ts
deno test backend/deno-proxy/main.test.ts
deno check --unstable-cron backend/deno-proxy/runtime.ts
deno test backend/deno-proxy/health-maintenance.test.ts
```

测试使用 mock HTTP / WebSocket，默认没有网络权限。最后一个测试使用仓库中实际打包的 Supabase SDK
检查匿名登录、邮箱密码登录、刷新、用户查询、退出、RPC、只读查询的请求兼容性。测试不证明云端网络可达、真实 Supabase Auth
或真实实时推送。

部署完成后先检查公开 `GET /health`。它只证明中转服务在运行，不表示 Supabase 可达。前端 SDK 的 `url` 可改成中转的 HTTPS
根地址，原来的公开 `publishableKey` 保持原项目值；SDK 会自行生成 `/auth/v1`、`/rest/v1` 和 `/realtime/v1/websocket`
地址。必须再做真实匿名回执、私密管理员登录、名单读取和两浏览器实时变化验收。

允许的网页来源仅有 `https://jianghuan3658.github.io`，以及供验收的 `http://localhost:8768`。完成本地验收后从
`ALLOWED_ORIGINS` 删除 localhost。API / WebSocket 均要求 Origin 命中该名单，且不会开放通配 CORS。Origin
不是身份验证；可手工伪造，它仅限制浏览器来源，真正的身份和管理员权限仍由 Supabase 验签、RPC 与 RLS 控制。

仅转发匿名注册、密码/刷新登录、用户读取、退出、三个婚礼 RPC、只读服务检查
RPC、婚礼名单只读查询、婚礼实时订阅。表查询只允许安全字段、有限分页；无直接表写、管理 API、邮箱注册、第三方跳转、任意
RPC 或任意 URL。仅允许公开 publishable / legacy anon API key 与 anon / authenticated
用户凭据；`sb_secret_*`、`service_role` JWT 在 HTTP 头/体、WebSocket URL/消息均被拒绝。JWT
解析仅用于拒绝凭据类型，不代替上游验签。

不转发 Cookie、Set-Cookie 或客户端转发头；不打印请求、响应、用户姓名、密码、会话令牌。所有 HTTP 响应
`Cache-Control: no-store`，不跟随上游重定向。HTTP 输入 64 KiB、输出 1 MiB、上游超时 10 秒；上游错误保留 SDK
所需代码和短消息，去除诊断细节和 HTML。

WebSocket 原样转发 Supabase 协议 1/2 的 JSON 文本，限婚礼表
`postgres_changes`、心跳、令牌刷新和离开；不支持广播/Presence 写入及客户端二进制广播。服务器返回的文本/二进制均受 64 KiB
限制。每个实例最多 64 连接，待上游连接的队列最多 16 条/256 KiB；连接超时 10 秒、空闲 75 秒、最长 1 小时后要求 SDK
重连。Web API 使用 4001/4003/4008/4009/4011/4013 应用关闭码，保证原生客户端 `close()`
真正生效。实例限制不等于跨实例全局限制；平台与 Supabase 的免费额度和速率限制仍然有效。

本服务可改善宾客到 Supabase 的线路，但上线后仍必须从国内普通网络实测；不能仅凭部署成功宣称所有中国网络都稳定可用。

长期运行维护：部署者需先独立执行 `backend/supabase/service-health.sql`，创建只读 `wedding_service_health()`。
它只运行一条 PostgreSQL 查询，返回 `{ok:true,checkedAt:UTC时间}`，不读取姓名、人数、名单或密钥，不制造回执或写入数据。
代理的 `/rest/v1/rpc/wedding_service_health` 只接受 `POST {}`，仍受相同来源和公开/用户凭据类型限制。

`runtime.ts` 在模块顶层、启动服务器之前注册 `wedding-service-health`，计划 `0 */6 * * *`，即每天 UTC 00/06/12/18 点
（北京时间 08/14/20/02 点）检查固定上游数据库接口，失败后最多在 1 分钟、5 分钟后各重试一次。部署时必须用此入口和 Cron
标志， 并在 Deno 控制台确认计划任务已被发现、有真实成功记录；mock 测试导入代理/辅助函数不会启动定时任务。 按照
[Deno Cron 官方说明](https://docs.deno.com/runtime/fundamentals/cron/)，条件分支或请求回调内的定义不会被部署发现。

定时检查只使用 `public-config.json` 中的 publishable key，它复制自本项目公开 `data/backend.json`，不依赖 24 小时管理
PAT、 管理员密码或任何私有凭据。上游请求只有公开 `apikey`，没有 `Authorization` 或
Cookie；配置和检查函数不依赖部署目录外的文件。 轮换项目公开 key 时必须同步更新这份公开配置。错误仅抛出通用
`SERVICE_HEALTH_FAILED`，不记录上游响应内容或凭据。

Supabase [官方生产检查文档](https://supabase.com/docs/guides/deployment/going-into-prod) 说明 Free 项目在 7
天内活动较低时可能暂停。每 6 小时的真实只读数据库检查可降低长期无人填回执时的暂停风险，
但平台没有保证这种访问必定阻止暂停；这也不能提供永久可用或 SLA 保证。应用被停用、额度用尽、公开 key 被撤销、
供应商策略或网络发生变化仍会中断服务。此检查不能自动恢复已暂停的项目。

实现按 [Deno 原生 WebSocket 文档](https://docs.deno.com/api/deno/websockets/) 与
[Supabase Realtime 协议文档](https://supabase.com/docs/guides/realtime/protocol) 核对。
