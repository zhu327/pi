/**
 * Grep / Find Tools Extension
 *
 * Ensures grep, find are always active across all sessions.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function grepFindLsExtension(pi: ExtensionAPI) {
	pi.on("session_start", async () => {
		const active = pi.getActiveTools();
		const names = ["grep", "find"];
		const rest = active.filter((name) => !names.includes(name));
		pi.setActiveTools([...names, ...rest]);
	});
}
