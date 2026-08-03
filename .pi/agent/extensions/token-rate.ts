import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "token-rate";

export default function (pi: ExtensionAPI) {
	let requestStartedAt: number | undefined;
	let hasTokenRate = false;

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "⚡ idle"));
	});

	pi.on("before_provider_request", (_event, ctx) => {
		requestStartedAt = performance.now();
		if (!hasTokenRate) {
			ctx.ui.setStatus(
				STATUS_KEY,
				ctx.ui.theme.fg("accent", "⚡ generating…"),
			);
		}
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant" || requestStartedAt === undefined) return;

		const elapsedSeconds = Math.max(
			(performance.now() - requestStartedAt) / 1_000,
			0.001,
		);
		const outputTokens = event.message.usage.output;
		requestStartedAt = undefined;

		const text = Number.isFinite(outputTokens)
			? `⚡ ${(outputTokens / elapsedSeconds).toFixed(1)} tok/s`
			: "⚡ output rate unavailable";
		hasTokenRate = Number.isFinite(outputTokens);
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", text));
	});

	pi.on("agent_end", (_event, ctx) => {
		if (requestStartedAt === undefined) return;
		requestStartedAt = undefined;
		if (hasTokenRate) return;
		ctx.ui.setStatus(
			STATUS_KEY,
			ctx.ui.theme.fg("dim", "⚡ output rate unavailable"),
		);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		requestStartedAt = undefined;
		hasTokenRate = false;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
