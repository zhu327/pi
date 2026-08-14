/**
 * LS / Grep / Find Tools Extension — single file.
 *
 * Enables ls, grep, find at session start (not "always active" — activation
 * happens once per session; other extensions or the user may change the
 * active set afterwards and this extension does not fight back).
 *
 * REFACTOR_PLAN.md tasks implemented:
 *   - LGF-1: the doc comment matches the behavior (session-start
 *     activation, not a continuous enforcement); PI_LSGF_DISABLE=1 turns
 *     the extension off; only tool names that actually exist in
 *     getAllTools() are activated.
 *   - LGF-2: when a name is provided by an override (sourceInfo.source is
 *     not "builtin"), a one-time warning is logged instead of silently
 *     re-activating someone else's implementation.
 *   - LGF-3: no polling/re-assertion after session_start; behavior stays
 *     predictable and composable with other extensions.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DISABLED = process.env.PI_LSGF_DISABLE === "1"; // LGF-1: opt-out

export default function lsGrepFindExtension(pi: ExtensionAPI) {
	let warnedOverrides = false; // LGF-2: one warning per extension instance, not per session

	pi.on("session_start", async () => {
		if (DISABLED) return; // LGF-1: environment opt-out
		const names = ["ls", "grep", "find"];

		// LGF-1: only activate names that really exist — filtering unknown
		// names into setActiveTools would discard the built-in's bookkeeping.
		const allTools = pi.getAllTools();
		const existing = names.filter((name) => allTools.some((tool) => tool.name === name));
		if (existing.length === 0) return;

		// LGF-2: an overridden name (sourceInfo.source !== "builtin") is not
		// ours to manage; warn once and keep the user's implementation.
		const overridden = existing.filter((name) => {
			const tool = allTools.find((t) => t.name === name);
			return tool?.sourceInfo && tool.sourceInfo.source !== "builtin";
		});
		if (overridden.length > 0 && !warnedOverrides) {
			warnedOverrides = true;
			console.warn(
				`[ls-grep-find] not forcing activation of overridden tool(s): ${overridden.join(", ")}`,
			);
		}

		const targetNames = existing.filter((name) => !overridden.includes(name));
		if (targetNames.length === 0) return;

		const active = pi.getActiveTools();
		// LGF-2 fix: filter by targetNames (not `names`) so an overridden tool
		// that is already active stays active — only our builtin targets are
		// re-asserted, the user's implementation is never silently disabled.
		const rest = active.filter((name) => !targetNames.includes(name));
		pi.setActiveTools([...targetNames, ...rest]);
	});
}
