// Scoped by Nanocodex to app + account. Reconnects resume the same Luna thread.
export const FAST_AGENT_CONVERSATION_ID = "da9bd48b-05f7-4ea0-93da-61e06cfb7e81";

/** This is history for the grant's assigned agent, never account-wide history. */
export const conversationAccess = {
  finalMessages: true,
  actionSummaries: true,
  conversationHistory: true,
  rawTraces: false,
} as const;
