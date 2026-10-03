"""Webhook settings in the existing per-row settings domain."""
from __future__ import annotations

from app.webhooks.contracts import Model, WebhooksConfig

MB = 1024 * 1024
GROUP_TITLES = {
    'webhooks_ingress': '接收设置', 'webhooks_capacity': '排队与同时处理',
    'webhooks_scripts': '脚本运行', 'webhooks_retention': '数据保留',
    'webhooks_statistics': '统计与通知',
}
LABELS = {
    'enabled': ('启用外部触发', '允许外部系统向已启用的触发器发送事件。关闭后不再接收新事件，已开始的操作可以完成。'),
    'publicBaseUrl': ('外部访问地址', '用于生成触发地址，例如 https://openbear.example.com。留空使用本系统的Web地址。'),
    'ingress.maxBodyBytes': ('单条事件内容大小', '一条外部消息最多可以多大，超过时拒绝接收。填写MB，可用小数；1 MB = 1024 × 1024字节。'),
    'ingress.requestsPerMinute': ('每分钟最多接收', '所有触发器合计每分钟允许接收多少次请求。控制消息进入的速度，不是同时执行的任务数；各入口可在高级设置中调低。'),
    'queue.maxEvents': ('最多等待处理的事件数', '所有触发器合计可保留多少条尚未处理或等待核实的事件。队列满时拒绝新事件，不删除已接收内容。'),
    'queue.maxBytes': ('待处理内容总容量', '所有触发器的待处理内容合计最多占用多少MB。与条数上限分别限制大消息和大量小消息，任一达到上限即暂停接收。'),
    'concurrency.preScripts': ('同时运行的前置脚本', '最多同时运行多少个消息预处理脚本。其余脚本等待空位，不影响手动聊天。'),
    'concurrency.postScripts': ('同时运行的后置脚本', '最多同时运行多少个结果处理脚本。前置与后置分开排队，避免结果处理堵住新消息。'),
    'concurrency.autoModelRuns': ('同时处理的自动会话', '最多同时让多少个会话处理外部事件。正在等待外部回复的任务不占名额，不限制手动聊天。'),
    'scripts.pythonPath': ('服务器Python解释器', 'Python脚本使用的服务器程序路径；未配置时自动查找。'),
    'scripts.nodePath': ('服务器Node解释器', 'JavaScript脚本使用的服务器程序路径；未配置时自动查找。'),
    'scripts.defaultCwd': ('脚本工作目录', '所有触发器脚本使用的服务器目录，请填写绝对路径。不会改变会话属性中用于提示模型的目录说明。'),
    'scripts.defaultTimeoutSeconds': ('脚本默认运行时间', '脚本最多运行多少秒。入口未单独填写时使用此值。'),
    'scripts.maxTimeoutSeconds': ('脚本最长运行时间', '入口设置的运行时间不能超过此值。到时停止脚本，不会撤销它已经完成的外部操作。'),
    'scripts.maxStdoutBytes': ('脚本返回内容大小', '脚本返回给OpenBear的内容最多多少MB。超出后记为失败，不截断后继续当作有效结果。'),
    'scripts.maxStderrBytes': ('每次脚本保留的日志大小', '每次脚本执行最多保留多少MB日志。达到上限后只停止保存更多日志，不中断脚本。'),
    'batching.maxBatchBytes': ('一批消息的内容上限', '一起交给模型的消息合计最多多少MB。入口的批量收集设置不能超过此值。'),
    'batching.maxBatchEvents': ('一批消息的条数上限', '一次合并处理最多包含多少条消息。入口可设置更少的条数。'),
    'retention.payloadDays': ('事件正文保留天数', '已处理事件的原始内容保留多少天。留空不自动清理；仍在处理或等待核实的内容不会清理。'),
    'retention.scriptLogDays': ('脚本日志保留天数', '已结束的脚本日志保留多少天。留空不自动清理；需要核实的日志继续保留。'),
    'retention.processingDays': ('处理详情保留天数', '已结束任务的处理详情保留多少天。留空不自动清理；仍被活动任务引用的详情继续保留。'),
    'retention.idempotencyDays': ('防重复记录保留天数', '已接收事件的身份至少保留多少天，用来避免同一消息重复处理。留空长期保留；关联证据仍需要时也不会删除。'),
    'retention.metricSampleDays': ('详细统计保留天数', '逐条统计数据保留多少天。清理后可继续查看已保留的汇总，界面会说明精度变化。'),
    'retention.metricRollupDays': ('汇总统计保留天数', '按时间汇总的统计保留多少天，不得少于详细统计的保留天数。'),
    'retention.businessRecordDays': ('业务记录保留天数', '脚本或模型上报的业务明细保留多少天。留空不自动清理；查询已清理的日期会提示数据缺失。'),
    'telemetry.maxDimensions': ('每个入口最多几个分类字段', '用于统计分组，例如地区、业务类型。只统计明确配置的字段，不自动猜测消息含义。'),
    'telemetry.maxCategoriesPerDimension': ('每个分类最多几个值', '例如“地区”最多保存多少种取值。更多取值合并到“其他”，不会丢弃原事件。'),
    'telemetry.maxSeriesPerEndpoint': ('每个入口最多几个统计分组', '限制不同分类组合产生的统计组数，防止把用户ID等不断变化的内容当成统计分类。'),
    'telemetry.maxBusinessRecordBytes': ('单条业务记录大小', '一条统计业务明细最多多少MB。统计写入失败不会让已完成的业务操作重做。'),
    'telemetry.gaugeDefaultStaleSeconds': ('状态指标多久未更新算过期', '例如“当前在线人数”，超过这些秒数没有新值时显示已过期，而不是显示为0。'),
    'notifications.digestSeconds': ('异常摘要默认间隔', '将这段时间内的异常合并通知，减少连续提醒。入口可在高级设置中另行指定；不会延迟需要你确认的操作。'),
}


def build_specs(factory):
    result = {}
    def walk(model, prefix=''):
        for name, field in type(model).model_fields.items():
            alias = field.alias or name; path = prefix + alias; value = getattr(model, name)
            if isinstance(value, Model):
                walk(value, path + '.')
                continue
            annotation = str(field.annotation)
            kind = 'bool' if annotation == "<class 'bool'>" else 'float' if 'float' in annotation else 'int' if 'int' in annotation else 'str'
            minimum = next((getattr(x, 'ge') for x in field.metadata if hasattr(x, 'ge')), None)
            maximum = next((getattr(x, 'le') for x in field.metadata if hasattr(x, 'le')), None)
            section = path.split('.')[0]
            group = 'webhooks_scripts' if section == 'scripts' else 'webhooks_retention' if section == 'retention' else 'webhooks_statistics' if section in ('telemetry', 'notifications') else 'webhooks_capacity' if section in ('queue', 'concurrency', 'batching') else 'webhooks_ingress'
            title, desc = LABELS[path]
            size = path.endswith('Bytes')
            unit = 'MB' if size else '秒' if path.endswith('Seconds') else '天' if path.endswith('Days') else '次/分钟' if path == 'ingress.requestsPerMinute' else '条' if path in ('queue.maxEvents', 'batching.maxBatchEvents') else '个' if section == 'concurrency' else ''
            result['webhooks.' + path] = factory('webhooks.' + path, title, desc, kind, group, '立即生效',
                min_value=minimum, max_value=maximum, nullable='None' in annotation,
                unit=unit, display_scale=MB if size else 1)
    walk(WebhooksConfig())
    return result
