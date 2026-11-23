const excludedDomains = {
  ads: '广告投放、审批和预算', analytics: '归因、报表和实验', campaign: '活动简报、预算和收尾',
  creator: '达人合作、物流和佣金', inbox: '客服流程与消息发送', lifecycle: '客户生命周期和 ESP',
  traffic: '落地页、表单和流量归因', workspace: '工作区管理和个人设置', agent: '通用工作流治理',
};

// Reasons for the priority routes remaining after the local scenarios. Each value describes what the case still needs.
const cases = {
  account_disable_social_account: ['scope_excluded', '会改变测试账号启用状态并清空 Connector 调度，本轮只修改本地资料。'],
  account_assign_account_block: ['missing_state', '需要有明确原因及待分派的账号阻断记录。'],
  account_probe_capabilities: ['external_unavailable', '缺少可授权探测的社媒连接与供应商沙箱。'],
  account_probe_store_capabilities: ['external_unavailable', '缺少可授权探测的远端商店连接。'],
  account_get_store_capabilities: ['missing_resource', 'CSV 店没有 connection_id，无法提供可读的店铺连接。'],
  account_list_connection_accounts: ['missing_resource', '测试社媒账号为本地登记，未关联包含发现账号的 OAuth 连接。'],
  account_preview_mobile_app_unbind: ['missing_resource', '仅配对合成桌面 Worker，缺少移动 App 绑定。'],
  account_preview_binding_migration: ['missing_resource', '缺少当前执行绑定和迁移目标绑定。'],
  commerce_store_sync: ['external_unavailable', '本地 CSV 店只有导入能力，缺少可同步的授权来源。'],
  commerce_variant_group_link_batch: ['fixture_unprepared', '单项映射已实测。批量还需至少两个同品牌、尚未映射的不同变体。'],
  commerce_variant_group_unlink: ['fixture_unprepared', '已有活动映射。尚未为解除关系和历史仍保留的断言补案例。'],
  commerce_change_acknowledge: ['missing_state', '缺少一次针对同一商品的源快照变化及其待确认事件。'],
  commerce_change_resolve: ['missing_state', '缺少指定变更事件和可验证的解决结果。'],
  commerce_change_dismiss: ['missing_state', '缺少待处理的变更事件及业务上可忽略的理由。'],
  commerce_promotion_cancel: ['fixture_unprepared', '已有本地计划优惠。尚未补取消及保留使用历史的断言。'],
  commerce_localization_export: ['missing_state', '已验证翻译送审，缺少经人工批准的翻译版本。'],
  commerce_order_get: ['missing_resource', '本轮只导入商品，缺少带清结算数据的订单夹具。'],
  commerce_inventory_rule_create: ['scope_excluded', '库存阈值与通知／暂停策略属于配置变更，本轮覆盖价格及库存观测。'],
  research_item_delete: ['fixture_unprepared', '证据条目已被引用或转化。需独立的未引用条目验证删除。'],
  alert_rules_evaluate: ['missing_state', '需要已启用且满足触发条件的监控规则。'],
  alerts_evaluate: ['missing_state', '需要已启用规则及满足触发条件的一组观测记录。'],
  alert_update: ['missing_resource', '尚无实际触发的告警供确认或处理。'],
  mention_labels_list: ['fixture_unprepared', '有本次合成提及，尚无供对照的人工标签及被替换标签。'],
  mention_label_update: ['fixture_unprepared', '有本次合成提及，尚未补两次标注及覆盖历史断言。'],
  mention_escalate: ['fixture_unprepared', '有本次合成提及，尚未验证升级产生的工作项及回链。'],
  share_of_voice_get: ['fixture_unprepared', '需要定义来源清单、品牌比较对象及时间窗。单条提及不足以验证占比。'],
  publishing_pause: ['scope_excluded', '暂停开关会改变发布范围的执行策略，本轮只操作单个合成目标。'],
  publishing_get_pause: ['missing_resource', '本轮未启用发布暂停开关，缺少可查询的暂停记录。'],
  publishing_get_slot_template: ['missing_resource', '没有槽位模板，本轮排期使用显式时间。'],
  publishing_get_schedule_rule: ['missing_resource', '没有周期排期规则，本轮使用一次性时间。'],
  publishing_get_evergreen_queue: ['missing_resource', '本轮没有常青内容队列。'],
  publishing_list_evergreen_items: ['missing_resource', '需要含候选内容的常青队列。'],
  publishing_suggest_evergreen_order: ['missing_resource', '需要含多个可排序内容条目的常青队列。'],
  publishing_get_review_round: ['missing_resource', '单目标审批已有回读，缺少独立审核轮次。'],
  publishing_suggest_post_match: ['missing_resource', '缺少已发布贴文及可与其匹配的目标。本轮贴文读回为零。'],
  publishing_get_execution: ['missing_state', '目标送审后保持待审，尚无已核准的发布执行任务。'],
  publishing_run_now: ['scope_excluded', '会调度执行器，缺少核准目标与隔离发布执行夹具。'],
  publishing_retry: ['missing_state', '缺少已标记安全可重试的失败执行任务。'],
  publishing_reconcile: ['missing_state', '缺少结果未知的任务和独立回执。'],
  execution_cancel_task: ['missing_state', '已覆盖待审批目标取消。执行层取消需已有任务。'],
  posts_get: ['missing_resource', '本轮贴文列表确认为零，无贴文记录可精确查询。'],
  posts_register_manual: ['external_unavailable', '缺少可如实登记的合法沙箱贴文和证据。'],
  publishing_preview_execution_batch: ['missing_state', '缺少可纳入批次的已有执行任务。'],
  publishing_apply_execution_batch: ['missing_state', '缺少已通过的执行批次预览和对应任务版本。'],
};
const routeFixtures = [
  [/^\/sync-/, '允许执行的来源及对应同步任务／调度记录'], [/^\/backfills/, '待补采的数据窗口、允许补采的来源及运行记录'],
  [/^\/data-gaps|^\/data-quality|^\/raw-records/, '经导入或同步生成的目标质量事件、缺口或原始记录'],
  [/^\/data-sources/, '与不同允许用途、窗口或连接相匹配的来源'], [/^\/imports?.*(error-file|preset)/, '专门含行级错误或可复用映射的 CSV 批次'],
  [/^\/topics/, '可复核采样定义与至少两个观察窗口'], [/^\/alert-rules/, '监控条件、阈值及可触发的样本'],
  [/^\/content-revisions|^\/content-variants.*(diff|translation)|^\/translation-links/, '可比较的两个修订或配对译文'],
  [/^\/feeds|^\/feed-items/, '授权本地信息源和可重复读取的条目'], [/^\/content-transcripts/, '带音轨的授权媒体及本地转录能力'],
  [/^\/asset-versions|^\/renditions/, '匹配的素材版本、派生参数和回读产物或失败状态'],
  [/^\/rights-grants|^\/rights\/check/, '另一个素材授权草稿或可验证的适用范围及权益状态'],
  [/^\/submission-boxes/, '独立投稿箱、投稿及审阅状态'], [/^\/templates/, '匹配工作流使用方式的模板及版本'],
  [/^\/knowledge/, '对应知识来源、导入正文或可审阅版本'], [/^\/content-(items|variants|pillars)|^\/ideas/, '独立的内容稿件及该转换、审核或归档所需版本'],
  [/^\/assets|^\/asset-folders/, '独立可归档或移动的合成素材及关联状态'], [/^\/promotions/, '可核对规则及使用历史的测试优惠'],
];

export function untested(op) {
  const exact = cases[op.name];
  if (exact) return { reasonCode: exact[0], reason: exact[1] };
  if (/^\/(devices|desktop|zhihu|device|browser)(?:\/|$)/.test(op.path)) {
    return { reasonCode: 'missing_resource', reason: '已配对合成 Worker 并实测签名心跳及队列。该路径另需对应绑定、设备能力或执行回执。' };
  }
  if (excludedDomains[op.module]) {
    return { reasonCode: 'scope_excluded', reason: `本回合未扩展${excludedDomains[op.module]}。该项需独立的「${op.summary ?? op.name}」案例。` };
  }
  const fixture = routeFixtures.find(([pattern]) => pattern.test(op.path))?.[1];
  if (fixture) return { reasonCode: 'fixture_unprepared', reason: `尚未为此操作补齐${fixture}。` };
  const params = op.path.match(/:[\w]+/g);
  return params
    ? { reasonCode: 'fixture_unprepared', reason: `尚未构造能验证「${op.summary ?? op.name}」的 ${params.join('、')} 记录及其业务状态。` }
    : { reasonCode: 'fixture_unprepared', reason: `尚未补「${op.summary ?? op.name}」的请求与预期结果夹具。` };
}
