/**
 * token-rate extension — single file.
 *
 * Shows the effective generation rate of the current provider request in the
 * footer status bar.
 *
 * REFACTOR_PLAN.md tasks implemented:
 *   - TR-1: "generating…" is shown only until the first rate has been
 *     displayed; afterwards the last rate stays fixed and is simply
 *     overwritten when the next request completes.
 *   - TR-2: per-request records; a request that never completes shows
 *     "request failed" (optionally with the previous rate marked as
 *     "last"), instead of silently keeping a stale rate.
 *   - TR-3: stopReason `error`/`aborted`/`pending` is never reported as a
 *     rate; output === 0 shows "no output".
 *   - TR-4: the metric is labeled "effective tok/s" (end-to-end, includes
 *     reasoning tokens); a TTFT (time-to-first-token) is shown when the
 *     first message_update was observed.
 *   - TR-5: state is reset on session_start; UI updates are guarded by
 *     hasUI + mode === "tui" (statistics still update in headless modes).
 *   - TR-6: the single-active-request assumption is explicit — overlapping
 *     requests increment a generation counter and supersede each other
 *     instead of silently mixing timestamps.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "token-rate";

/** One provider request under observation (TR-6: explicit single-flight model). */
interface RequestRecord {
	generation: number;
	requestedAt: number;
	firstTokenAt?: number;
	finished: boolean;
	outcome?: "success" | "failed";
}

export default function (pi: ExtensionAPI) {
	let current: RequestRecord | undefined;
	let lastRateText: string | undefined;
	let generation = 0;

	const uiActive = (ctx: { hasUI: boolean; mode: string }): boolean =>
		ctx.hasUI && ctx.mode === "tui"; // TR-5

	function setStatus(ctx: Pick<ExtensionContext, "hasUI" | "mode" | "ui">, text: string): void {
		if (!uiActive(ctx)) return; // TR-5: no footer side effects in print/json/rpc
		ctx.ui.setStatus(STATUS_KEY, text);
	}

	function rateText(outputTokens: number, elapsedSeconds: number): string {
		return `${(outputTokens / elapsedSeconds).toFixed(1)} tok/s`;
	}

	pi.on("session_start", (_event, ctx) => {
		// TR-5: fresh state per session; no stale rate survives /reload.
		current = undefined;
		lastRateText = undefined;
		generation = 0;
		if (uiActive(ctx)) {
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "⚡ idle"));
		}
	});

	pi.on("before_provider_request", (_event, ctx) => {
		generation += 1;
		// TR-6: an overlap supersedes the previous request (its timestamp
		// must not be mixed into the new one). The superseded request is
		// reported as failed when agent_end eventually fires.
		if (current && !current.finished) {
			current.finished = true;
			current.outcome = "failed";
		}
		current = {
			generation,
			requestedAt: performance.now(),
			finished: false,
		};
		// TR-1: once a rate has been displayed, keep it fixed; only a
		// completed request may overwrite it. "generating…" is shown only
		// for the very first request (or after a "no output" request).
		if (lastRateText === undefined) {
			setStatus(ctx, ctx.ui.theme.fg("accent", "⚡ generating…"));
		}
	});

	pi.on("message_update", (event) => {
		// TR-4: first observed content/thinking delta counts as first token.
		if (event.message.role !== "assistant") return;
		if (current && !current.finished && current.firstTokenAt === undefined) {
			current.firstTokenAt = performance.now();
		}
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant" || current === undefined || current.finished) return;

		const message = event.message as {
			stopReason?: string;
			usage?: { output?: number; reasoning?: number };
		};
		const stopReason = message.stopReason;
		const outputTokens = typeof message.usage?.output === "number" ? message.usage.output : undefined;
		const reasoningTokens = typeof message.usage?.reasoning === "number" ? message.usage.reasoning : undefined;
		current.finished = true;

		// TR-3: error/aborted/pending responses never yield a rate.
		if (stopReason === "error" || stopReason === "aborted" || stopReason === "pending" || outputTokens === undefined) {
			current.outcome = "failed";
			const suffix = lastRateText ? ` · last ${lastRateText}` : "";
			setStatus(ctx, `${ctx.ui.theme.fg("warning", "⚡ request failed")}${suffix}`);
			return;
		}
		if (outputTokens === 0) {
			current.outcome = "success";
			lastRateText = undefined;
			setStatus(ctx, ctx.ui.theme.fg("dim", "⚡ no output"));
			return;
		}

		// TR-2: a finished request overwrites the "last" rate.
		current.outcome = "success";
		const elapsedSeconds = Math.max((performance.now() - current.requestedAt) / 1_000, 0.001);
		const ttft = current.firstTokenAt !== undefined ? current.firstTokenAt - current.requestedAt : undefined;
		let text = `⚡ ${rateText(outputTokens, elapsedSeconds)}`;
		if (reasoningTokens !== undefined && reasoningTokens > 0) {
			const nonReasoning = Math.max(outputTokens - reasoningTokens, 0);
			text += ` (${rateText(nonReasoning, elapsedSeconds)} excl. reasoning)`;
		}
		text += " effective"; // TR-4: end-to-end, not decode-only
		if (ttft !== undefined) {
			text = `TTFT ${(ttft / 1_000).toFixed(1)}s · ${text}`;
		}
		lastRateText = text;
		setStatus(ctx, ctx.ui.theme.fg("accent", text));
	});

	pi.on("agent_end", (_event, ctx) => {
		if (current === undefined) return;
		if (current.finished) {
			// Success/failure already rendered by message_end; keep the
			// record until the next request starts.
			return;
		}
		// TR-2: the request never produced a final message.
		current.finished = true;
		current.outcome = "failed";
		const suffix = lastRateText ? ` · last ${lastRateText}` : "";
		setStatus(ctx, `${ctx.ui.theme.fg("warning", "⚡ request failed")}${suffix}`);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		current = undefined;
		lastRateText = undefined;
		if (uiActive(ctx)) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	});
}
