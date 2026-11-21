import { PermitError } from '../../connector/src/permit.ts';
import { defaultLanguage, translate, type DesktopLanguage } from '../ui/i18n.mjs';

type CopyValue = string | number;

export class DesktopError extends Error {
  private constructor(private readonly key: string, private readonly values: CopyValue[]) {
    super(translate(defaultLanguage, key, ...values));
  }

  static create(key: string, ...values: CopyValue[]) { return new DesktopError(key, values); }

  display(language: DesktopLanguage) { return translate(language, this.key, ...this.values); }
}

// The shared device client exposes these fixed messages without a separate error code.
const deviceMessages = new Set([
  '商品任务未分配给此设备。',
  '商品任务中的店铺信息无效。',
  '商品数据超过服务的请求大小限制，请分批导出。',
  '商品表尚未获得预览确认。',
]);

const actionErrors: Record<string, string> = {
  pair: '配对失败。请检查工作区 ID、设备名称和配对码，并确认服务可以访问。',
  connect: '未能连接工作台。请检查服务地址和网络后重试。',
  forget: '无法清除本机配对。请检查本机安全存储和文件权限后重试。',
  claim: '无法领取社媒任务。请检查工作台任务配置和连接状态。',
  creator: '无法打开官方创作者页面。请检查系统默认浏览器设置。',
  'session-creator': '无法打开官方创作者页面。请检查系统默认浏览器设置。',
  'verify-session': '未能核验会话。请检查会话 ID、实际账号 ID 和连接状态。',
  media: '无法读取选中的媒体。请检查文件是否存在以及本机读取权限。',
  confirm: '未能确认交接。请检查实际账号 ID 和工作台任务状态。',
  finish: '无法回填结果。请检查作品 ID、证据和任务状态。',
  block: '未能发送中止报告。请在工作台核实任务状态。',
  report: '未能重试回填。请检查连接状态，并在工作台核实任务。',
  workbench: '无法打开工作台。请检查系统默认浏览器设置。',
  'catalog-claim': '无法领取商品导入任务。请检查工作台任务配置和连接状态。',
  'catalog-portal': '无法打开卖家后台。请检查系统默认浏览器设置。',
  'catalog-file': '无法打开商品导出表。请检查文件和本机读取权限。',
  'catalog-upload': '尚未收到商品表确认。请先在工作台检查是否已有预览。',
  'update-install': '无法安装已验证的更新。请稍后重试。',
};

export function displayError(language: DesktopLanguage, action: string, error: unknown) {
  if (error instanceof DesktopError) return error.display(language);
  if (error instanceof Error && deviceMessages.has(error.message)) return translate(language, error.message);
  if (error instanceof Error && error.name === 'AbortError') return translate(language, '操作已取消。');
  if (error instanceof PermitError) {
    if (action === 'pair' && [400, 401, 403, 404, 409, 410, 422].includes(error.status)) {
      return translate(language, '服务拒绝了配对。请核对工作区 ID，或在工作台重新生成配对码。');
    }
    if ([401, 403, 404].includes(error.status)) return translate(language, '服务拒绝了设备请求。请在工作台检查设备授权。');
  }
  return translate(language, actionErrors[action] ?? '操作失败。请检查输入和连接状态后重试。');
}
