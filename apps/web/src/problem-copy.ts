import { localizedLabel, type Tuple } from '@smartsell/ui';

const messages: Record<string, Tuple> = {
  invalid_credentials: ['使用者名稱、電子郵件或密碼不正確。', 'The username, email, or password is incorrect.', '用户名、电子邮箱或密码不正确。'],
  invalid_invitation: ['邀請無效或已失效。請向管理員索取新邀請。', 'The invitation is invalid or has expired. Ask an administrator for a new one.', '邀请无效或已过期。请向管理员索取新邀请。'],
  already_configured: ['工作區已設定，請返回登入。', 'The workspace is already set up. Go back to sign in.', '工作区已完成设置，请返回登录。'],
  session_not_established: ['無法建立登入工作階段，請重新登入。', 'The sign-in session could not be established. Try signing in again.', '无法建立登录会话，请重新登录。'],
  invalid_response: ['伺服器回應格式不正確。請重新整理後再試。', 'The server returned an unexpected response. Refresh and try again.', '服务器响应格式不正确。请刷新后重试。'],
  invalid_input: ['請檢查表單中的必填項目及格式。', 'Check the required fields and their formats.', '请检查表单中的必填项和输入格式。'],
  invalid_request: ['請檢查輸入並重試。', 'Check your inputs and try again.', '请检查输入后重试。'],
  transaction_retry: ['操作未完成，請稍後重試。', 'The operation did not complete. Try again shortly.', '操作未完成，请稍后重试。'],
  unsupported_media_type: ['不支援此檔案或請求格式。', 'This file or request format is not supported.', '不支持此文件或请求格式。'],
  invalid_csv: ['無法讀取 CSV，請確認檔案符合範本。', 'The CSV could not be read. Check it against the template.', '无法读取 CSV，请确认文件符合模板。'],
  invalid_header: ['欄位名稱不符，請使用匯入範本。', 'The column headers do not match. Use the import template.', '列名不匹配，请使用导入模板。'],
  csv_too_large: ['CSV 檔案太大，請分批匯入。', 'The CSV is too large. Split it into smaller files.', 'CSV 文件过大，请分批导入。'],
  invalid_xlsx: ['無法讀取此工作簿。請使用支援的 XLSX 檔案，並以數值取代公式。', 'Could not read this workbook. Use a supported XLSX file and replace formulas with values.', '无法读取此工作簿。请使用受支持的 XLSX 文件，并用数值替换公式。'],
  xlsx_too_large: ['XLSX 檔案太大，請分批匯入。', 'The XLSX workbook is too large. Split it into smaller files.', 'XLSX 文件过大，请分批导入。'],
  invalid_row_count: ['資料列數超出允許範圍。', 'The file has an unsupported number of rows.', '数据行数超出允许范围。'],
  invalid_mapping: ['請檢查匯入範本與來源欄位的對應。', 'Check the mapping between the import template and source columns.', '请检查导入模板与源文件列之间的映射。'],
  import_file_required: ['請選擇要匯入的檔案。', 'Choose a file to import.', '请选择要导入的文件。'],
  import_expired: ['匯入預覽已過期，請重新產生預覽。', 'The import preview has expired. Generate a new preview.', '导入预览已过期，请重新生成预览。'],
  import_not_editable: ['此批次不再等待確認。請重新整理並檢查狀態。', 'This batch is no longer awaiting confirmation. Refresh and check its status.', '此批次已不再等待确认，请刷新并检查状态。'],
  evidence_expired: ['此匯入資料的原始證據已過期。', 'The source evidence for this import has expired.', '此导入数据的原始证据已过期。'],
  import_invalid: ['匯入預覽有錯誤。修正後請重新預覽。', 'The import preview contains errors. Fix them and preview again.', '导入预览中有错误。请修正后重新预览。'],
  column_count: ['此列的欄位數與標題列不符。', 'This row has a different number of columns from the header.', '此行的列数与表头不符。'],
  dup_in_file: ['已略過完全相同的重複資料列。', 'An identical duplicate row was skipped.', '已跳过完全相同的重复行。'],
  conflicting_duplicate: ['具有相同合併鍵的資料列內容不一致。', 'Rows with the same merge key disagree.', '具有相同合并键的数据行内容不一致。'],
  stale_source: ['已略過較舊的來源資料。', 'Older source data was skipped.', '已跳过较旧的来源数据。'],
  ambiguous_variant: ['此列符合多個商品規格，請確認識別碼。', 'This row matches multiple variants. Check its identifiers.', '此行匹配多个商品规格，请检查标识符。'],
  variant_not_found: ['找不到此列對應的商品規格。', 'No variant matches this row.', '找不到与此行匹配的商品规格。'],
  variant_product_conflict: ['此規格已屬於另一個商品。', 'This variant already belongs to another product.', '此规格已属于另一个商品。'],
  title_required: ['新增商品必須填寫名稱。', 'A title is required for a new product.', '新增商品时必须填写名称。'],
  store_market_not_found: ['找不到此列對應的已啟用市場。', 'No enabled market matches this row.', '找不到与此行匹配的已启用市场。'],
  order_not_found: ['請先匯入退款所對應的訂單。', 'Import the original order before its refund.', '请先导入退款对应的订单。'],
  currency_mismatch: ['退款幣別與原訂單不符。', 'The refund currency does not match the original order.', '退款币种与原订单不一致。'],
};

const statusMessages: Record<number, Tuple> = {
  400: messages.invalid_request!,
  401: ['登入已失效，請重新登入。', 'Your sign-in has expired. Sign in again.', '登录已失效，请重新登录。'],
  403: ['沒有執行此操作的權限。', 'You do not have permission for this operation.', '没有执行此操作的权限。'],
  404: ['找不到此資料，可能已被移除或無法存取。', 'This record was not found. It may have been removed or be inaccessible.', '找不到此记录，可能已被移除或无法访问。'],
  409: ['目前狀態不允許此操作。請重新整理後確認資料。', 'This operation conflicts with the current state. Refresh and review the record.', '当前状态不允许此操作。请刷新后核对记录。'],
  412: ['其他人已更新此資料。請重新整理、核對後再送出。', 'This record was updated. Refresh and review it before resubmitting.', '此记录已被更新。请刷新并核对后重新提交。'],
  413: ['檔案或請求太大。', 'The file or request is too large.', '文件或请求过大。'],
  422: messages.invalid_input!,
  429: ['操作太頻繁，請稍後再試。', 'Too many requests. Try again shortly.', '请求过于频繁，请稍后重试。'],
  503: ['服務暫時無法使用，請稍後再試。', 'The service is temporarily unavailable. Try again shortly.', '服务暂时不可用，请稍后重试。'],
};
const serverError: Tuple = ['伺服器無法完成操作，請稍後再試。', 'The server could not complete the operation. Try again shortly.', '服务器无法完成操作，请稍后重试。'];

/** Translate stable codes, never message bodies or their embedded record values. */
export function problemSummary(locale: string, code?: string, status?: number): string | undefined {
  const codeKey = code?.toLowerCase() ?? '';
  const key = codeKey === 'invalid_column_count' ? 'column_count' : codeKey;
  const message = Object.hasOwn(messages, key) ? messages[key] : statusMessages[status ?? 0] ?? (status && status >= 500 ? serverError : undefined);
  return message && localizedLabel(message, locale);
}
