# 婚礼用餐报名后端

请帖继续由现有 GitHub Pages 地址发布。姓名和人数存放在 CloudBase 的私有数据库；GitHub 仓库不保存报名数据。`admin.html` 是主人管理入口，页面源码公开不等于名单公开，实际读取权限由 CloudBase 和云函数校验。

## 当前交付状态

- 云函数、主人登录页、访客提交客户端、权限模板和本地测试已经实现。
- `data/backend.json` 的 `env` 与 `adminUid` 当前为空：访客提交会明确提示待开通，管理页不会显示模拟数据或虚假的 0 人统计。
- 还没有开通真实环境，也未验证国内 API、真实权限或更新时间。填写环境 ID 不能代替实际部署和验收。
- 免费环境资格、月度配额和费用须查看此账号实际控制台。不会自动付费升级。

## 运行方式

1. 访客通过浏览器 SDK 无感匿名登录，再调用普通事件云函数 `wedding-rsvp`。姓名为 1–40 个字符，用餐人数是含本人 1–20 的整数。
2. 云函数从 SDK 的可信运行上下文读取 UID、登录类型与来源 IP；不相信正文里的 `uid`、`adminUid` 或身份标记。普通事件函数使用平台临时访问凭据，不在前端配置服务密钥。
3. 一个匿名 UID 只保存一组报名；再次提交修改同一组。匿名身份无法证明跨设备同名是同一个人，因此管理页提示同名，交给主人核对。
4. 客户端在三字段接口内部追加 `operationId`。同内容重试复用它，编辑内容分配新的 ID。事务同时更新本人报名、操作回执和限流状态；旧操作重试返回当前记录，不会回放旧内容。每 UID 每分钟最多 10 次新操作、同来源 IP 最多 100 次，已接受操作的重试不重复计数。只保存限流标识哈希，不保存明文 IP。
5. 主人用单独的账号密码登录。服务端 `ADMIN_UID` 是权限依据；前端的同名字段只是公开配置，不构成授权。数据库规则只允许该非匿名 UID 读 `wedding_rsvps`，普通客户端全部禁止写库，回执和限流集合全部拒绝客户端访问。
6. 管理页实时监听最近更新的记录，将变更当作重新读取信号；每 5 秒再次校对。读取用 `_id` 游标完整分页，每页最多 100，满页继续读取下一页，所有页合计。实时监听首屏不会作为完整人数来源。
7. 连接中断显示上次成功更新时间；刷新失败不清空旧数据。浏览器返回缓存页会重新授权并恢复同步。姓名用 `textContent` 渲染；CSV 导出对公式前缀转义。

## 本地验证

在 `backend/` 执行：

```sh
npm ci --ignore-scripts
npm test
npm run vendor-sdk
```

9 项测试覆盖输入验证、25 次并发重试只写一组、本人修改及旧请求重试、事务回滚、服务器身份伪造拒绝、限流、205 条完整分页合计、未配置的明确状态、CSV 公式转义。事务测试使用可回滚的内存适配器；它不证明云平台的实际事务行为、网络或延迟。

浏览器 SDK 固定 `@cloudbase/js-sdk@3.10.1`，只打包 App/Auth/Database/Functions/文档 watch 模块到 `assets/vendor/cloudbase-browser.js`，不依赖远程 SDK 脚本。Node SDK 固定 `@cloudbase/node-sdk@3.18.3`。锁文件可重现依赖；厂商许可证随 vendor 文件保存。

## 开通与部署

以下工作仅在用户授权后实际执行；现在的配置是模板。

1. `tcb login` 浏览器/设备码授权，并查看现有环境和免费额度；复用合适的上海免费环境，未获得付费授权时不新购付费环境。
2. 配置精确 Web 安全来源 `jianghuan3658.github.io`，开通匿名登录和管理账号的用户名/邮箱密码登录。管理员账号须从实际创建结果获得唯一 UID，不能用用户名代替 UID，不能把密码写进 JSON、源码或 GitHub。
3. 创建文档数据库集合：`wedding_rsvps`、`wedding_rsvp_receipts`、`wedding_rsvp_limits`。
4. 将 `database.rules.template.json` 中的 `__ADMIN_UID__` 替换为实际 UID，分别应用对应集合规则；再应用 `functions.rules.json`。默认禁止未明示授权的云函数调用。不要把模板占位符直接当真实授权提交。
5. 在本地的 `cloudbaserc.json` 配置实际 `envId`、`ADMIN_UID`，普通事件函数运行时默认 `Nodejs20.19`（部署前核对该环境支持情况）。从 `backend/` 执行 `tcb fn deploy wedding-rsvp -e <实际环境ID> --install-dependency true`。已有同名服务须核对范围，不能盲目覆盖无关资源；本项目不需要 HTTP 函数、HTTP 网关公网匿名入口或自定义域名。
6. 在真实后端全部配置并通过权限验证后，填 `data/backend.json` 的环境 ID 和 UID；保留 `region: ap-shanghai`。仅公开环境标识，不填写任何 APIKey、SecretKey、密码或 token。
7. 将页面和 vendor SDK 一起发布到 GitHub Pages。`backend/node_modules/`、SDK 检查缓存与 tarball、临时本地授权配置均被 backend 的 `.gitignore` 排除，不得发布。

## 云端验收必做

- 两个不同浏览器/设备用虚构测试姓名登记，在主人页检查人数与组数；同身份修改人数、提交结果超时后相同请求重试，不多算人数。
- 未登录用户、匿名用户和另一个普通实名账户分别测试读取名单、直接写数据库、调用 list/authorize；全部应拒绝。前端伪造管理 UID 不应生效。
- 测试 205 条数据完整分页，包含恰好 100/200 条末页；不把默认查询条数当全部报名。
- 用国内电信、联通、移动网络分别测试页面、身份 API、云函数调用与实时连接。已能访问 GitHub 页面不证明 CloudBase API 已可用。
- 正常联网且服务可用时，测试从服务端提交成功到主人页可见是否在 10 秒内；这是验收目标，不是网络故障期间的绝对保证。模拟断网、恢复、切换后台、浏览器返回缓存页，检查重连和最后更新时间。
- 服务端真实错误时不得显示成功；无法访问免费额度或未部署时不得呈现模拟名单。验收结束清理授权创建的虚构测试记录。

## 官方技术依据

- [浏览器 SDK 初始化、地域与普通事件函数临时凭据](https://docs.cloudbase.net/api-reference/webv3/initialization)
- [匿名登录、账号密码登录与身份接口](https://docs.cloudbase.net/api-reference/webv3/authentication)
- [服务端事务](https://docs.cloudbase.net/database/transaction)
- [云函数权限](https://docs.cloudbase.net/cloud-function/security-rules)
- [数据库安全规则](https://docs.cloudbase.net/database/security-rules)
- [文档实时监听](https://docs.cloudbase.net/recipes/add-realtime-notifications-database-watch)
- [CLI 浏览器/设备码授权](https://docs.cloudbase.net/cli-v1/install)
- [函数部署](https://docs.cloudbase.net/cli-v1/functions/deploy) 和 [支持的运行时](https://docs.cloudbase.net/cli-v1/config)
- [CloudBase 定价](https://www.cloudbase.net/pricing)

另已在 npm 官方包源码核验 Node SDK 3.18.3 的 `src/auth/index.ts`：`getAuthContext(context)` 读取 `TCB_UUID` 与 `LOGINTYPE`，`getCloudbaseContext(context)` 读取平台注入环境；本地 `hasGetAuthContext/hasRuntimeContext/hasRunTransaction` 检查通过。此证据只确认 SDK 方法存在及实现来源，实际环境的上下文需云端验收。
