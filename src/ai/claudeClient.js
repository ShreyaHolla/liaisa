// Live adapter (AI_MODE=live). Same interface as mockClient. Never used in tests.
// The SDK is imported on first call, so mock mode never loads it.
// No retries here: the agent loop retries once, so every attempt counts toward the cap.

/**
 * @param {{ apiKey: string, models: Record<string,string>, timeoutMs?: number }} opts
 *   models maps a purpose ('intake') to a model ID.
 */
export function createClaudeClient({ apiKey, models, timeoutMs = 20000 }) {
  let sdk = null;
  return {
    async createMessage({ purpose, system, tools, messages, maxTokens, toolChoice }) {
      if (!sdk) {
        const { default: Anthropic } = await import('@anthropic-ai/sdk');
        sdk = new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 0 });
      }
      // No temperature: the intake model rejects it (HTTP 400 "Extra inputs are not permitted").
      const r = await sdk.messages.create({
        model: models[purpose],
        max_tokens: maxTokens,
        system,
        tools,
        tool_choice: toolChoice,
        messages,
      });
      return {
        content: r.content,
        stopReason: r.stop_reason,
        usage: {
          input: r.usage.input_tokens ?? 0,
          output: r.usage.output_tokens ?? 0,
          cacheRead: r.usage.cache_read_input_tokens ?? 0,
          cacheWrite: r.usage.cache_creation_input_tokens ?? 0,
        },
        model: r.model,
      };
    },
  };
}
