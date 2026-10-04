# Cron API与前端接入契约

此文是当前实现契约。管理接口复用登录会话认证，camelCase，时间为ISO8601 UTC。错误为非2xx `{code,message,details?,currentRevision?}`。工具使用同一服务。定时任务只绑定目录，一目录多任务，每次实际执行新建会话；无收集、排队、并发上限或停机补跑。

## 资源

Job：`{id,folderId,folderName,folderPath,name,description,enabled,revision,config,nextRunAt,scheduleState,activeRuns,lastRun,createdAt,updatedAt}`。

- scheduleState: armed/disabled/exhausted/missed/target_missing/deleted。
- activeRuns 是次数，lastRun 为Run摘要或null。folderId创建后不可修改。
- config：
```json
{
  "schedule":{"kind":"cron","timezone":"Asia/Shanghai","expression":"0 9 * * *","at":null,"everySeconds":null,"anchorAt":null},
  "runConfig":{"mainModel":null,"mainThinkingLevel":null,"mainFastMode":null},
  "instructions":"",
  "timeoutSeconds":null,
  "totalTokensBudget":null,
  "costBudgetUsd":null,
  "notifications":{"mode":"inherit","errorsOnly":false},
  "pre":{"enabled":false,"runtime":"python","code":"","timeoutSeconds":30,"onError":"fail","retry":{"maxAttempts":1,"backoffSeconds":[2,10,30,60]}},
  "post":{"enabled":false,"runtime":"python","code":"","timeoutSeconds":30,"onError":"fail","retry":{"maxAttempts":1,"backoffSeconds":[2,10,30,60]},"onOutcomes":["completed","failed","timed_out","tokens_exceeded","cost_exceeded","cancelled"]}
}
```

- 时间规则kind支持at/every/cron；at用带时区ISO时间；everySeconds正整数，anchorAt为空由保存时固定起点；cron只支持五段表达式，使用IANA timezone。预览与执行同一计算器。
- runConfig逐项null继承目录、系统，false明确关闭Fast；复用现有ModelSettings和模型能力校验。
- timeoutSeconds为前置＋模型执行限时，post独立脚本超时；预算null不限制，正数启用；总Tokens包含主控及子Agent，费用缺失直接忽略，不阻断。已发出的调用可能超出预算。
- 脚本runtime python/node；前置stdin为空（没有业务参数），后置stdin为本次结果JSON；都有OPENBEAR_CRON_JOB_ID、OPENBEAR_CRON_RUN_ID、OPENBEAR_CRON_CONVERSATION_ID、OPENBEAR_CRON_SCHEDULED_AT环境变量；stdout/stderr保存日志，不要求Webhook JSON协议。
- onError fail/continue表示重试耗尽后失败/继续。post重试只重试post，不重做模型。post耗尽且onError=fail可将最终status记post_failed，outcome仍保存原业务结果。
- notifications.mode inherit/silent/telegram/push/both。inherit沿用系统会话通知设置；其余选择渠道但仍受渠道可用性约束；errorsOnly仅异常通知。

Run：`{id,jobId,jobName,folderId,trigger,scheduledAt,startedAt,finishedAt,conversationId,rootTurnId,status,phase,outcome,error,totalTokens,costUsd,modelCalls,durationSeconds,notificationState}`；详情另含`configSnapshot,preAttempts,postAttempts,finalText`。
status：starting/running/completed/failed/timed_out/tokens_exceeded/cost_exceeded/cancelled/interrupted/post_failed/missed。
phase：starting/pre/model/post/finished。trigger scheduled/manual。
脚本attempt：`{attempt,startedAt,finishedAt,exitCode,errorClass,errorSummary,stdout,stderr,stdoutTruncated,stderrTruncated}`。

## HTTP

- GET `/api/cron/jobs?folderId=&search=&enabled=true|false&limit=30&offset=0` → `{items,total}`。不传folderId查询全部目录。
- POST `/api/cron/jobs` `{folderId,name,description,enabled:false,config,requestId}` → `{job}`。
- GET `/api/cron/jobs/{id}` → `{job}`。
- PATCH `/api/cron/jobs/{id}` `{name,description,enabled,config,expectedRevision,requestId}` → `{job}`。完整配置，CAS冲突409，草稿不能丢。
- POST `/api/cron/jobs/{id}/control` `{enabled,expectedRevision,requestId}` → `{job}`。仅未来计划启停，不影响当前运行。
- POST `/api/cron/jobs/{id}/run` `{expectedRevision,requestId}` → `{run}`。真实立即执行一次，即使计划disabled也可手动运行；不改变正常下次时间。
- POST `/api/cron/jobs/{id}/delete-impact` `{expectedRevision}` → `{impact:{activeRuns,retainedRuns},confirmationToken}`。
- DELETE `/api/cron/jobs/{id}` `{confirmationToken,requestId}` → `{job}`。停用并软删除定义，当前执行继续，保留运行及会话；前端先显示此影响并确认。无独立停止执行按钮。
- GET `/api/cron/runs?jobId=&folderId=&status=&start=&end=&limit=30&offset=0` → `{items,total}`。start/end为ISO或毫秒，按startedAt筛选。
- GET `/api/cron/runs/{id}` → `{run}`。
- POST `/api/cron/runs/{id}/stop` `{requestId}` → `{run,...stopResult}`。供工具复用对应会话停止；前端打开会话使用已有停止。
- POST `/api/cron/preview-next` `{schedule,count:5}` → `{times:[ISO...]}`。不执行业务。
- GET `/api/cron/folders` → `{items:[{id,name,path,parentId}]}`。保留目录现有顺序；目录属性入口使用folderId筛选。
- GET `/api/cron/environment` → `{runtimes,defaultCwd}`，runtime结构复用Webhook环境查询；模型选项和目录继承继续使用现有Api.rathOptions及conversationFolderProperties。
- GET `/api/cron/statistics?jobId=&folderId=&start=&end=` → `{runs,completed,failed,cancelled,interrupted,limited,active,totalTokens,costUsd,averageDurationSeconds}`，终态时长平均，不做高级指标。

## 界面

独立CronView；侧栏「文档库」与「Skills」之间增加「定时任务」，路径/cron。目录属性提供入口跳到同一页面并按folderId筛选（可使用路由查询参数），会话属性不增加Cron配置。列表、基础编辑、运行历史详情、简单统计；现有会话树／Webhook页保持原行为。
复用ModelSettings、AdaptiveMdEditor、ScriptCodeEditor（若现有）、基础字段和主题变量。不可直接把完整WebhookEditor复制成CronEditor；不要照搬凭据、聚合、队列、回执界面。长内容内部滚动，底部操作固定。
所有模型/金额/Token数值可读；统计0与空值正确区分。事件来源使用cron且新会话标题包含定时名称。通知在后置完成后发出，避免模型done提前重复通知。
