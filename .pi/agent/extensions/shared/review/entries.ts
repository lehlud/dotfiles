export type ActionAudit = {
  decision?: string;
  reason?: string;
  requestId?: string;
  fingerprint?: string;
  toolCallId?: string;
  multiplexAgent?: string;
  cwd?: unknown;
  action?: { tool: string; arguments: Record<string, unknown> };
  technicalFailure?: boolean;
  technicalStage?: string;
};

export type Entry = {
  id?: string;
  type: string;
  message?: {
    role: string;
    content?: unknown;
    toolCallId?: string;
    toolName?: string;
    details?: unknown;
    isError?: boolean;
  };
  customType?: string;
  data?: unknown;
};

export type ReviewedEvidence = {
  tool: string;
  arguments: Record<string, unknown>;
  path?: unknown;
  cwd: unknown;
  requestId: string;
  content: unknown[];
  details: unknown;
};
