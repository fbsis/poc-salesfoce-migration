import type { CrmClient } from '../crm-client';

/** Everything the tool handlers are allowed to touch. */
export interface ToolContext {
  crm: CrmClient;
}
