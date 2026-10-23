# 受管运行包接口与维护

同一仓库、镜像、前端。Docker 用固定 uv 版本从既有 `uv.lock` 冻结导出并按 hash 安装生产依赖，不自由解析升级；镜像带主控需要的 SSH client。只有 `OPENBEAR_INSTANCE_ROLE=managed` 精确值进入子模式；未设置、空值、其他值均为原主控。子模式不构造 Bot，不启动任何 TG 接收/发送/通知桥，不启用自更新服务。普通主控的 TG 登录和数据布局不变。

## Bootstrap 与持久化

挂一个专属卷到 `/workspace`；不要挂 Docker socket、主控目录/密钥或其他租户数据，不要用 privileged/host PID/host network。先在卷内准备 `openbear.json`：使用当前项目的真实 models/providers/primary、memory 等业务配置，不需要 telegram。不能靠假模型/假 Bot 凭证让无效配置通过启动校验。

首次启动变量：
- `OPENBEAR_INSTANCE_ROLE=managed`
- `OPENBEAR_INSTANCE_ID`：稳定实例 ID（字母、数字、`_`、`-`，1–128 字符）
- `OPENBEAR_MANAGEMENT_KEY`、`OPENBEAR_REPORT_TOKEN`：不同的至少 32 字符随机 ASCII 密钥
- `OPENBEAR_CONTROLLER_URL`：合法 HTTP(S) root origin；公网 IP、域名、IPv6 均允许，不含目录/查询/片段/凭证，不要求特定网络。
- 新网关部署：`OPENBEAR_CHILD_AUTH=gateway`、`OPENBEAR_GATEWAY_KEY`（至少 32 字符随机 ASCII，不能与管理 key/健康 report token 相同）；**不需要、不创建子实例本地账户**。
- 兼容旧本地模式：`OPENBEAR_CHILD_AUTH=local`（旧卷/未配置默认值）、`OPENBEAR_USERNAME`、`OPENBEAR_PASSWORD`，首次本地账户密码 12–1024 字符。新网关部署不得依赖此默认值。
- `OPENBEAR_WORKSPACE=/workspace`（默认）；配置默认 `/workspace/openbear.json`，`OPENBEAR_CONFIG` 如覆盖仍须位于卷内

首次成功建档后，本地账户 seed 不再使用；重建时只需明确 managed 角色和同一个卷，身份/key/controller URL/auth_mode/gateway_key 从卷恢复。若仍提供旧 identity 环境变量，必须与卷一致，否则拒绝启动，防止错挂其他实例卷。角色本身永不从卷或业务 JSON 推断。

卷内布局：`openbear.json` 及备份、`data/`（业务 DB 及其关联 DB/媒体/工具产物）、`workspace/`（任务文件）、`skills/`、`mcp-servers/`、`.home/`（用户依赖缓存）、`.managed/`（scrypt 账户、身份与独立 Webhook pepper、outbox/jobs SQLite、运行锁）。配置路径解析和状态检查约束在卷内；持久根与监听地址不能运行期改动。系统 apt 等修改仍属于容器临时层，重建可能丢失。

`status.persistence.mounted` 从 Linux `/proc/self/mountinfo` 精确判断根是独立挂载点；不是仅看路径或可写性。未挂载显示健康降级，不构成部署验收成功。它证明当前挂载事实，卷保留政策及重建保留仍需部署者正确执行。

## HTTP

- `GET /api/auth/mode` 公共 JSON 仅返回 `{ok:true,mode}`；managed 附带 `X-OpenBear-Instance` 真实实例 ID 响应头供公共路由验真，controller 不附带；无密钥。
- 仅 local 模式子 `POST /api/auth/password/login {username,password}`；成功 `{ok:true}`，复用 host-only、HttpOnly、SameSite=Lax 会话 Cookie，HTTPS 时 Secure。
- local 模式 `GET /api/auth/session` 含 mode；现有 logout/sessions/revoke 可用。gateway 模式禁用子实例所有本地 auth 会话入口、Cookie 登录、账号改密；网关负责这些接口。
- 仅 local 模式子 `POST /api/auth/password/change {currentPassword,password,username?}`：必须 Cookie 登录且验证旧密码；成功撤销全部会话。管理 Bearer 不得调用这些会话/账号接口。
- 子 `/api/managed/v1/*` **始终**单独校验管理 Bearer；Cookie 和 gateway key 均不替代 key。
- gateway 业务请求：`X-OpenBear-Gateway-Key` + `X-OpenBear-Instance` 必须匹配本卷真实凭证/ID；另要求 `X-OpenBear-Gateway-Session` 非空可打印不透明标识（最多 1024 字符），不是原始 Cookie。网关须剥离客户端内部头、Cookie 和 Authorization；子实例拒绝混用。只授予既有业务资源族，不含 auth、instances、system restart/update 或 managed API。WebSocket 每帧/空闲持续重验，轮换后旧 key 失效；网关会话撤销/停用由网关断开对应连接。
- `GET /api/gateway/v1/probe`：仅 gateway 模式，要求有效 gateway key + 本实例 ID 两个头，不要求 session；返回真实 managed status 同形证据。管理 Bearer 不替代该 probe 的网关鉴权。
- `GET /api/managed/v1/status`：契约状态，额外 `persistence.mounted`；健康独立于 LLM 可用性。
- `GET/PATCH /api/managed/v1/config`：`{ok,config}`，PATCH 请求直接为部分业务配置对象，递归保留遗漏字段，走原 ConfigStore 校验/备份/热应用钩子。不包含 managed/telegram/管理秘密。
- `POST /api/managed/v1/jobs {command,timeoutSeconds?}` -> HTTP 202 `{ok:true,job}`；`GET .../jobs/{id}`、`POST .../jobs/{id}/cancel` -> `{ok:true,job}`。
  job 有 `id,status,command,timeoutSeconds,createdAtMs,startedAtMs?,finishedAtMs?,output,truncated,exitCode`。最多并行 4 个，命令最多 65536 字符，超时 1–3600 秒（默认 120），输出最多 1 MiB，保留最近 200 个任务；停止/超时杀进程组，重启遗留标记 interrupted，不重跑。
- `PUT /api/managed/v1/files/{skills|mcp}/{relative/path}`：`{content:string}` 或 `{base64:string}`，可加 `executable:boolean`；单文件最大 512 KiB。原子写入各自配置根，拒绝绝对路径、点/隐藏组件、遍历、符号链接。响应 `{ok,kind,path,bytes}`。不解压不受控 archive。
  Skills 写完调用原 `/api/skills/reload`。MCP 写文件后 PATCH 业务 config 的 `mcp.servers`（command/args/cwd/env 等），热重载或原 `/api/mcp/reload`。
- 原业务路由由明确的业务资源族允许管理 Bearer（见 `http.BUSINESS_ROOTS`）；禁 auth Cookie 签发、instances、report ingress、角色切换、system restart/update。实际业务处理器仍按同一本地 owner 校验归属。本地 owner ID 为正保留值 `1`，是数据库本地主体，不是伪 TG 账号。旧卷 owner=-1 在监听/后台任务启动前事务迁移：仅 `owner_chat_id`、`web_sessions.chat_id` 登录主体及明确的 owner 编码偏好键；绝不改业务 `internal_chat_id`、`messages.chat_id`、Agent task chat_id、首会话 session/history。

管理配置接口可读写业务 provider/MCP 凭证，属于管理 key 权限范围；勿把结果发到普通日志。工具、Bash、MCP、浏览器子进程移除管理环境变量是防意外泄漏措施，**不等于同 UID 安全隔离**：获授权 Bash/文件工具能够访问自己卷内文件。

## 自动事件

子实例程序自动发 `heartbeat/health/recovery`；仅 local 模式附加 `login_success/login_failure`。gateway 模式登录事件由网关用独立 token 上报，子实例不会上报本地登录；迁移前遗留待发登录事件保留为 dead、不再发送。没有模型报告工具、业务转发或任务升级。独立 outbox SQLite，事件 ID 保持不变；ACK 必须匹配 ID。HTTPS 校验证书、不接受携凭证重定向、不读取代理环境。网络失败不阻塞使用/登录；最多 12 次指数退避（封顶约一小时），失败事件保留 dead 状态；总行数上限 10000，优先淘汰 dead/旧 heartbeat。heartbeat 60 秒生成，待发送 heartbeat 合并。数据字段仅程序定义的状态、原因、issues、ready，不包含登录名、密码或 token。

## 显式离线维护（不能对运行中的卷执行）

仅在主控授权的维护操作中：停止该子容器，保留原卷；用同一个镜像运行一次性维护容器，仍只挂此卷、不挂 socket。维护 CLI 与运行时争用同一个内核独占锁，卷正在使用会拒绝。

1. 账户恢复：把 `{username,password}` JSON 从安全 stdin 传入：
   `python -m app.managed.maintenance --workspace /workspace reset-account`
   修改 scrypt verifier 并撤销该卷中的所有旧会话；不需要遗失的旧密码。
2. 管理 key/报告 token/网关业务 key 撤销轮换或控制器迁移：stdin JSON 包含一个或多个 `managementKey`、`reportToken`、`gatewayKey`、`controllerUrl`：
   `python -m app.managed.maintenance --workspace /workspace rotate-identity`
   原 instance ID 和 Webhook pepper 不变。旧管理 key 即被替换；旧 report token 要同时在主控受保护记录中撤销/更新；controller URL 要与主控实例记录同步。更新/移除旧容器 env seed 后再创建同卷子容器。不要把新密钥放 shell argv、会话文本或普通日志。
   此 CLI 只修改子卷，不宣称已更新主控 vault，也不自行联系或变更远程主控。
3. 旧 local 卷显式迁移到 gateway：安全 stdin 传 `{authMode:"gateway",gatewayKey:"新独立随机key"}` 给 `python -m app.managed.maintenance --workspace /workspace set-auth`。要求停机并取得卷锁；撤销旧本地会话，持久切换鉴权模式，保留 pepper/业务历史/旧账户文件但关闭本地认证。同步网关使用同一 businessKey，再移除/更新旧环境 seed。仅已有本地账户的 legacy 卷可显式 `set-auth {authMode:"local"}` 恢复兼容入口，该操作清除 gateway key 并再次撤销会话；不会同时启用两种登录。gateway 账户应在网关维护，子实例 `reset-account` 拒绝 gateway 模式。
4. 如使用非默认配置文件，账户恢复/模式切换可加 `--config /workspace/relative-config.json`，仍必须位于卷内。

CLI 输出只有 `{ok,action}`，错误不回显输入。不要删除 identity/account 文件来“修复”不匹配，也不要删卷重新部署。

## 网关浏览器推送

网关业务代理另传可信内部头 `X-OpenBear-Gateway-Origin`（配置的 publicUrl root origin）和 `X-OpenBear-Gateway-Expires`（原会话 Unix 秒截止时间）。节点仅在业务 key、实例 ID、Gateway-Session 全部通过验证后使用这两个头，不取浏览器 Origin 或 JSON body 猜测地址/期限。旧网关缺这两个头会拒绝推送绑定；其他业务不受影响。

业务数据库中的 `managed_push_sessions` 保存 `sha256(UpstreamID)`、实例 ID、可信 origin、expiry/revocation；不保存原始 Cookie/UpstreamID，不创建可登录节点的影子 `web_sessions`。最多 1000 条；注册/状态等访问及原有定期清理会删除过期/已撤销映射和关联订阅。管理 Bearer 不能注册设备会话。同一浏览器 endpoint 重新绑定其他网关会话会清除原会话待发队列和 presence；status/presence/解绑只操作当前绑定。

每次实际发送（包括测试按钮），节点先请求该记录 origin 的精确 `GET /api/gateway/v1/session-status`，使用对应实例的 businessKey Bearer、`X-OpenBear-Instance` 和 `X-OpenBear-Gateway-Session-Hash`。允许 HTTP，HTTPS 正常验证证书，不跟随重定向、不使用代理环境；5 秒超时、响应上限 4 KiB。`active=false`/过期立即抑制并撤销；网络、鉴权或存储异常不向 provider 发消息，按原队列最多三次/15 分钟有效期重试。不会以缓存的曾经有效结果放行。网关检查等待期间发生解绑/本地期限到达也不投递。

gateway 的完成/失败/交互/推荐/测试等最终 payload 均包含本实例 `instanceId`，包括旧待发记录；controller/local payload 和 Cookie 撤销行为保持不变。验证：`pytest tests/test_gateway_push.py tests/test_web_push.py tests/test_web_push_regressions.py`；只使用 HTTP 网关 fixture 并捕获 provider 调用，不真实外发。

## 集成与验证入口

`Services` controller 分支：`InstanceService(db,web_admin)`，`host.instances`，启动/关闭，初始和热重建时 `register_instance_tools`。routing 调 `install(app,host,service)`，仅实际注册的事件 POST 路由豁免 Cookie，report token 仍由 controller handler 验证。managed 分支：`host.managed_runtime`，无 controller 工具/路由能力。

`pytest tests/test_managed_gateway.py tests/test_managed_runtime.py tests/test_managed_integration.py`。主控负责最终前后端合并与部署路由验收。
