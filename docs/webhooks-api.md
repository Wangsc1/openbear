# Webhook 管理 API

实现契约（2026-10-03）。JSON camelCase，时间 ISO8601 UTC；持续时间秒，大小 bytes，费用 USD。所有管理接口复用现有管理员会话认证；Bearer 入口 Key **不是**管理凭据。错误非 200：`{code,message,retryable,details,currentRevision?,effectState?}`。列表分页 `limit`（1–100）、`cursor`，返回 `{items,nextCursor}`。

## 配置

- `GET /api/webhooks?scopeType=folder|conversation&scopeId=...`，可选 `search`，返回 `{items:Endpoint[],nextCursor}`。
- `GET /api/webhooks/{id}` → `{endpoint:Endpoint}`。
- `POST /api/webhooks`：`{scope:{type,id},name,description,config,enabled:false,requestId}` → 201 `{endpoint,credential?:{key,displayOnce:true}}`。同 requestId 重试返回原入口但不重发 Key；遗失须轮换。
- `PATCH /api/webhooks/{id}`：`{name,description,config,enabled,expectedRevision,expectedControlRevision,requestId}` → `{endpoint}`。config 是完整规则对象，服务端补齐省略的默认字段，不与旧 revision 隐式合并。冲突409带 `currentRevision` 和 `details.current`，不覆盖。

Endpoint：`{id,scope:{type,id},name,description,config,target,enabled,revision,controlRevision,effectiveStatus,pauseReasons,dispatchPaused,modelPaused,pendingEvents,activeWaits,url,credential:{hasCredential,prefix,createdAt,expiresAt},createdAt,updatedAt}`。

config 包含 `target,processing,idempotency,correlation,pre,post,batching,expiry,limits,statistics,notifications`。`config.target` 是提交权威；`endpoint.target` 仅是它的只读展示投影。scope 创建后不可修改。普通 Endpoint 永无 Key/hash；导出规则不含 ID/凭据/控制/历史。默认 disabled，草稿可缺处理指令；启用必须校验。

`target.runConfig` 为 `{mainModel:null,mainThinkingLevel:null,mainFastMode:null}`，字段均可省略/null；新会话逐项按入口覆盖→目录祖先链→系统默认解析，`false` 明确关闭 Fast，不是继承。保存及运行复用既有目录/会话模型能力校验与默认规范化；显式不支持的思考/Fast拒绝，继承项按最终模型能力规范化。新会话实际采用解析结果。固定会话拒绝任何非null覆盖，始终保留会话自身模型设置；目录入口固定目标必须为绑定目录当前子树内未归档会话，会话入口只能固定自己，后续搬出或归档也会阻断运行。

入口高级 `limits` 保留接收、积压、前置/后置/模型并发限额；null直接采用系统同项值，系统总量上限仍同时生效。接收按自然分钟计数，不再有突发量或另一层入口默认值。`processing.eventTemplate/resultSchema`、通知摘要策略及间隔均保留。

脚本仅inline `code` 和语言 `runtime`（python/node）；解释器与cwd来自系统设置，框架继续注入 `OPENBEAR_*` 协议环境，保留输入/输出、超时、重试、错误处理与回执语义。脚本返回 `aggregation_key` 仍有效；默认不按正文分组，入口及revision批次隔离不变。

已删除配置由新API严格拒绝：`budget`、`batching.groupBy/missingGroupValue`、`limits.burst`、脚本 `sourceMode/entryFile/interpreter/cwd/env`，以及系统 `ingress.burst/endpointDefaultPerMinute/endpointDefaultBurst`、`queue.endpointDefaultEvents/endpointDefaultBytes`。不修改历史DDL签名、历史事件/回执或旧revision原文。

- `POST /api/webhooks/{id}/control`：`{action:"set_enabled"|"pause"|"resume"|"stop",enabled?,scope?:"current"|"all"|"model",expectedControlRevision,requestId}` → `{endpoint,impact:{pendingEvents,activeWaits,runningStages,stopped,unconfirmed}}`。resume 仅解除指定人工暂停，不清未知/目标阻断。
- `POST /api/webhooks/{id}/delete-impact`：`{stopRunning:false,expectedControlRevision}` → `{impact,confirmationToken,expiresAt}`。
- `DELETE /api/webhooks/{id}` JSON：`{confirmationToken,requestId}` → `{endpoint,impact}`，保留历史。
- `POST /api/webhooks/{id}/credentials/rotate` prepare：`{prepare:true,expectedControlRevision,graceSeconds:0}` → `{impact,confirmationToken,expiresAt}`；提交 `{confirmationToken,requestId}` → `{endpoint,credential:{key,displayOnce:true},previousValidUntil}`。0立即撤销旧Key；显式宽限1–3600秒。

## 环境与目标

- `GET /api/webhooks/environment` → `{runtimes:[{runtime:"python"|"node",available,path,version}],defaultCwd,publicBaseUrl,publicReachability:"unverified",defaults:config,limits:{...}}`。不执行用户脚本，不自动安装解释器。
- `GET /api/webhooks/targets?scopeType=folder|conversation&scopeId=...&search=...&selectedId=...` → `{items:[{id,type:"folder"|"conversation",name,title,path,parentId,selectable,available}],nextCursor}`。目录范围只列当前目录及全部下级目录中的未归档会话；仅传scopeId也按目录解释。会话范围只返回该会话自身。目录不可选择；selectedId只能保留范围内未归档项，不绕过范围/归档限制。搜索保留命中项的合法祖先。平面树按主目录树顺序（目录先于会话，各组置顶优先、display_order升序、created_at/id降序）输出，前端不另做字母排序。

## 事件记录

产品preview/test actions、HTTP routes和专用测试收件模式已删除。验收使用正常生产者收件路径及隔离开发测试，不存在绕过Key认证的管理测试入口。
- `GET /api/webhooks/events?endpointId=&cursor=&limit=&state=` 跨有权入口分页；`GET /api/webhooks/{id}/events?cursor=&limit=&state=` → `{items:EventSummary[],nextCursor}`。
- `GET /api/webhooks/events/{eventId}` → `{event:{eventId,endpointId,receiveSeq,receivedRevision,processingRevision,receivedAt,expiresAt,state,reviewRequired,reason,payloadStatus,raw:{query,content,body,contentType},derived,stages,assignments,receipts,waitCandidates}}`。
- `POST /api/webhooks/events/{eventId}/retry`：`{requestId,stage:"pre"|"post"|"model",expectedVersion,verification?}` → `{eventId,jobId?,effectState}`；未知外部效果未核实409，不一键重做整链。
- `GET /api/webhooks/waits?endpointId=&assignmentId=&eventId=&active=true&scopeType=folder|conversation&scopeId=&search=&effectiveStatus=` → `{items,nextCursor}`，item 含 `waitId,assignmentId,endpointId,match,deadline,state,claimed,delivered,version,canCancel`；claimed/delivered 是 eventId 数组。eventId 筛选同时包括已认领和待解决候选。活动/所属对象/搜索/有效状态均先筛选后分页；cursor/nextCursor是独立等待游标，不得使用入口列表游标。
- `POST /api/webhooks/waits/{waitId}/control`：`{action:"cancel"|"resolve_match",requestId,expectedVersion,reason?,eventId?}` → `{wait}`。resolve_match 选择当前wait为指定冲突事件的唯一归属；以事务CAS核对候选。expectedVersion 是所选 wait 的 version，不是事件 version；不存在 events/{eventId}/resolve-match 接口。运行工具的 register/await/report 身份来自宿主，不接受浏览器冒充 run。

## 统计

`GET /api/webhooks/statistics?endpointId=&scopeType=&scopeId=&start=&end=&view=overview|phases|metrics|business|ranking` → `{view,range:{start,end,coverageStart,resolutionSeconds,coverageStatus,gaps},overview?,phases?,metrics?,items?,nextCursor?,warnings:[]}`。coverageStatus=complete|partial|unavailable；gaps 为 `{start,end,kind,endpointId}` 数组，coverageStart 可 null；warnings 中 retention_gap:<kind> 表示历史证据缺口。unavailable 的空或0不能展示为可信“没有业务”；partial只表示保留样本。

overview：`{activeEndpoints,pendingEvents,needsReview,requests,rejected,duplicates,accepted,preAttempts,preContinue,preHandled,preIgnored,modelEvents,modelBatches,modelCalls,postAttempts,queue:{[state]:count},usage:{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,cacheHitRate,costUsd,unknownUsageCalls,unknownCostCalls},oldestPendingAt}`。known小计与未知数量并列，无调用缓存率null；cacheHitRate=0..1。usage新增 `providerReportedCostUsd,estimatedCostUsd,unclassifiedCostUsd`（costUsd来源拆分）、`costSources:{providerReported,estimated,unclassified,unknown}`（调用计数）、`ledgerDeletedCalls,missingLedgerCalls,coverage,warnings`。coverage=complete|projected|incomplete；projected表示原账本已删但统计投影仍可追溯，incomplete表示历史计费凭据缺失，不能归零；warnings包括 original_ledger_deleted/missing_billing_evidence/estimated_cost/unclassified_cost_source。

phases 每项：`{phase,label,count,averageSeconds,p50Seconds,p95Seconds,maxSeconds,precision:"raw"|"bucketApproximation"}`。计量层级另列 `measurementLevel:event|batch|assignment|attempt`；不得把共享模型墙钟按事件倍乘。

metrics 每项含 `endpointId,scope,name,type,unit,labels,count,sum,min,max,lastValue,lastObservedAt,stale,buckets?,precision,coverage,warnings`；业务记录标 script/model 来源，排行必须声明 queryable 字段。平台指标只读，观测补交不重跑业务。

各视图支持相同 `endpointId/scopeType/scopeId/start/end` 范围；`start/end` 支持 ISO8601 或毫秒整数，区间左闭右开。响应含 `queryableFields:[{name,valueType,endpointIds}]`、`fieldConflicts:[{name,endpointIds}]`。跨入口同名字段的类型或取值路径不一致时，不混合查询，须选具体入口；冲突返回 `ambiguous_business_field`。

business 支持 `filters` JSON 对象，多条件精确匹配且保留 string/number/boolean 类型（`"0"` 不等于 `0`，`false` 不按空值处理）；返回 `items:[{recordId,endpointId,scope,event,observedAt,source,fields,evidenceRefs}]`。分页游标同时包含观察时间和记录ID。ranking 用 `field` 选择已声明字段，返回 `{value,valueType,count,endpointIds}`；相同计数以字段值稳定排序。事件列表也支持上述范围与 `state` 筛选，分页前完成筛选。

## 详情和受控恢复

事件详情新增 `version`（路由CAS）、`retryStages:["pre"|"post"|"model"]`（只列当前合法可重试阶段）、`effectState:"none"|"reported"|"confirmed"|"unknown"`。未知未核实绝无无提示重跑。另含 `canRebind:boolean`、`verifyStages:["pre"|"post"|"model"]`，均由服务器当前状态计算；执行时仍须 CAS，UI 不能把能力字段当授权。

`stages:[{jobId,stage,state,revision,version,actionKey,queuedAt,terminalAt,attempts:[{attemptId,attemptNo,executionFence,state,startedAt,finishedAt,exitCode,errorClass,errorSummary,sideEffectState,stderr,stderrTruncated,execution:{interpreter,cwd,sourceSha256,runtime},result}]}]`。
`assignments:[{assignmentId,originKind,conversationId,rootTurnId,initialBatchId,state,recoveryState,version,repairCount,claimedAt,deliveredAt,waitId,finalizedAt,terminalReason,notificationKey,canRecover,notificationState,canRetryNotification,notificationEffectState,runs:[{runId,relationKind,billingScope,taskId}]}]`。

`stages` 仅脚本逻辑 job/attempt；模型运行关联在 assignments[].runs。`canRecover` 要求尚未finalized、needs_control且无存活runtime；`canRetryNotification` 只在该Webhook通知适配行paused时true。`notificationState` 是现有outbox的状态或notQueued，delivered只表示渠道已幂等入队/会话事件已发布；`notificationEffectState` 为 enqueued/notEnqueued/unknown，不代表真实外部渠道已送达。渠道未知效果仍由既有TG/Push worker政策核实，不重发业务。
`receipts:[{receiptId,eventId,resultVersion,assignmentEventId,stageAttemptId,source,runId,actionId,outcome,disposition,reviewRequired,summary,reason,evidenceRefs,result,reportedAt}]`。source 是 model/script/framework/administrator；administrator 是为显式人工核实新增的独立声明来源，不冒充脚本、模型或框架实测。reported 不冒充 verified。

`phaseSpans:[{spanId,phase,measurementLevel,endpointId,eventId,batchId,assignmentId,attemptId,startedAt,endedAt,durationSeconds,endReason,shared,source:"framework"}]` 展示本事件计时及关联批次／整轮的共享计时，不复制同批其他事件的独立耗时。未记录结束时 `durationSeconds:null`，不是0或成功；共享耗时不乘事件数。人工确认、外部等待独立成段。

`observations:[{operationId,source,state,errorReason,createdAt,appliedAt}]` 将待补交、已写入、被拒绝与业务回执分开；观测失败不回滚业务，补交不重跑业务。

- `POST /api/webhooks/events/{eventId}/verify`：`{requestId,expectedVersion,stage:"pre"|"post"|"model",outcome:"completed"|"skipped"|"failed"|"unknown",reason,evidenceRefs,result?}` → `{eventId,version,effectState,receiptId}`。真实管理员记录外部核实声明与依据；只核实/收尾，不新增业务attempt，不重放原动作。保留原脚本/模型声明，并追加 source=administrator 的核实记录，不伪装框架实测成功。
- `POST /api/webhooks/{id}/rebind`：prepare `{prepare:true,eventIds:[...],expectedRevision,toRevision}` → `{impact,confirmationToken,expiresAt}`；确认 `{confirmationToken,requestId}` → `{eventIds,processingRevision,unchangedEventIds}`。仅未执行阶段/未分配模型项；receivedRevision、TTL、成功前置不变，已执行部分不换规则。
- `POST /api/webhooks/assignments/{assignmentId}/recover`：prepare `{prepare:true,expectedVersion,decision:"finalizeInterrupted",reason,evidenceRefs}` → `{impact,confirmationToken,expiresAt}`；确认 `{confirmationToken,requestId}` → `{assignmentId,state,version}`。核实原runtime后明确异常终结，绝不从头重演未知运行。
- `POST /api/webhooks/assignments/{assignmentId}/notification/retry`：`{requestId,expectedVersion,verification?}` → `{notificationKey,state}`。只沿既有通知outbox补交；发送成功而ACK不明先核实，绝不重跑前置/模型/后置。

## 运行等待和核实边界

工具 `wait/await` 遇到真实人类插话时返回 `{waitId,state:"human_interruption",events:[],registrationPreserved:true}`，让现有主控处理原插话；不伪造外部交付、不取消登记、不重复外部发送。模型可依新的人类指令继续 await 或显式 cancel。serial 前置与同会话其他入口的 serial 前置互斥；外部等待释放执行阶段，恢复模型须重新取得容量并等待 serial 前置结束。

report 只接受本 assignment 的存活 runtime。`tool-action:` 引用必须对应本轮已结束的真实工具 action；模型声明仍不冒充框架实测。pre/post 核实记录关联对应 attempt，不覆盖模型逐事件回执；model 核实仅解除该 assignment 的 review 阻断，保留人工暂停。

## 会话属性补充

`GET /api/conversations/{uuid}/properties` → `{properties:{contextMode:"inherit"|"override",contextText,inheritedContext,sourceFolderId,effectiveContext}}`。
`PUT /api/conversations/{uuid}/properties`：`{contextMode,contextText}` → 相同响应。只保存局部配置，不写启用系统模板、不构建提示词候选、不改冻结快照；其他位置的原 prompt diff/apply 保持不变。模型继续既有 model/thinking/fast/agent-run-config。

系统能力只用现有 settings 的 `webhooks.*` 字段和逐项 PATCH，不新增配置存储。

## 敏感管理确认

prepare 不执行动作。confirmationToken 仅管理员敏感响应返回，5分钟失效，绑定owner、动作、入口、规则及控制版本、精确参数/影响；执行前复核版本和影响，改变即409要求重新prepare确认。一次消费，同requestId重试返回已提交结果（永不重发Key）；其他requestId重用拒绝。普通`confirmed:true`不授权。工具端不向模型暴露可自批令牌，先走现有真实UserInteraction；拒绝/取消/附条件回复均不执行旧请求。

## 外部生产者

`POST /webhook/{id}`，Bearer Key，application/json 或 text/plain（UTF-8），可选 Idempotency-Key → 202 `{eventId,duplicate,acceptedAt,status:"accepted"}`，仅代表持久收件。身份=入口+生产者ID；内容比较=基础Content-Type+按顺序保留重复键的已解析query+原始正文bytes，JSON空白差异也冲突409。未提供ID且未配置bodyIdPath，每次新身份。
`GET /webhook/{id}/events/{eventId}` 以同入口 Key 认证，只返回收件回执，不暴露处理结果、会话正文或管理配置。413正文过大；429容量/限流（Retry-After）；503未持久接受。Key轮换不改变事件身份。
