/**
 * Model Patches Extension
 *
 * Applies model-specific patches similar to opencode's model-patches plugin:
 *
 * For ali/qwen3.7-max: prepends a xhigh reasoning prompt to the system
 *    prompt to encourage deep reasoning.
 *
 * Usage:
 *   Place in ~/.pi/agent/extensions/ (auto-discovered) or load with -e flag.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const XHIGH_REASONING_PROMPT =
  "Reasoning effort is set to xhigh. Please think carefully through the task, validate key assumptions, consider plausible alternatives, and prioritize correctness, consistency, and clarity in the final answer.";

export default function modelPatches(pi: ExtensionAPI) {
  // Prepend xhigh reasoning prompt to the system prompt when using ali/qwen3.7-max
  pi.on("before_agent_start", async (event, ctx) => {
    const model = ctx.model;
    if (!model) return;

    // model.id is "ali/qwen3.7-max" (already includes the namespace prefix
    // from the wps-gateway provider config)
    if (model.id !== "ali/qwen3.7-max") return;

    return {
      systemPrompt: XHIGH_REASONING_PROMPT + "\n\n" + event.systemPrompt,
    };
  });
}
