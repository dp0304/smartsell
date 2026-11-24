/** A media_upload failure returned to the model as an MCP tool error (§7.3). */
export class ToolError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;
  readonly issues: Record<string, unknown>[] | undefined;
  constructor(code: string, message: string, details?: Record<string, unknown>, issues?: Record<string, unknown>[]) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.details = details;
    this.issues = issues;
  }
}

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  structuredContent: Record<string, unknown>;
  isError?: true;
}

export function toolResult(value: Record<string, unknown>, note?: string): ToolResult {
  const content: ToolResult['content'] = [{ type: 'text', text: JSON.stringify(value) }];
  if (note) content.push({ type: 'text', text: note });
  return { content, structuredContent: value };
}

export function toolError(error: ToolError): ToolResult {
  const body = { error: { code: error.code, message: error.message, ...(error.issues && { issues: error.issues }), ...(error.details && { details: error.details }) } };
  return { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body, isError: true };
}
