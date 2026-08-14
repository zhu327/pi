/**
 * Todo Extension — Task management with 4-state lifecycle, dependencies,
 * persistent overlay widget, and improved rendering. Single file.
 *
 * Upgrades from the basic version:
 * - 4 status states: pending → in_progress → completed, plus deleted tombstone
 * - Richer actions: create, update, list, get, delete, clear
 * - Task fields: subject, description, activeForm, blockedBy (dependencies)
 * - Persistent overlay widget above the editor (auto-shows/hides)
 * - Better renderCall/renderResult with glyphs and status colors
 * - Improved /todos command with status grouping and counts
 * - Transition validation (e.g. can't go from completed back to in_progress)
 *
 * State is stored in tool result details (not external files), which allows
 * proper branching — when you branch, the todo state is automatically
 * correct for that point in history.
 *
 * REFACTOR_PLAN.md tasks implemented: T-1 (sequential execution), T-2
 * (single in_progress), T-3 (blockedBy gates transitions), T-4 (delete
 * checks reverse deps), T-5 (overlay prioritizes active tasks), T-6
 * (widget lifecycle: invalidate only clears cache, reconcile unmounts),
 * T-7 (update normalizes subject), T-8 (deleted tombstone immutable),
 * T-9 (domain errors throw → isError=true) plus extras: activeForm
 * required on in_progress, Integer id schema with minimum, blockedBy
 * dedupe, blockedBy status display, renderCall free of mutable state,
 * typed ExtensionUIContext/TUI/Component overlay.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

interface Task {
	id: number;
	subject: string;
	description?: string;
	activeForm?: string;
	status: TaskStatus;
	blockedBy?: number[];
}

interface TaskDetails {
	action: TaskAction;
	params: Record<string, unknown>;
	tasks: Task[];
	nextId: number;
}

type TaskAction = "create" | "update" | "list" | "get" | "delete" | "clear";

interface TaskState {
	tasks: Task[];
	nextId: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATUS_GLYPH: Record<TaskStatus, string> = {
	pending: "○",
	in_progress: "◐",
	completed: "●",
	deleted: "⊘",
};

const STATUS_COLOR: Record<TaskStatus, "dim" | "warning" | "success" | "muted"> = {
	pending: "dim",
	in_progress: "warning",
	completed: "success",
	deleted: "muted",
};

const STATUS_LABEL: Record<TaskStatus, string> = {
	pending: "pending",
	in_progress: "in progress",
	completed: "completed",
	deleted: "deleted",
};

const ACTION_GLYPH: Record<TaskAction, string> = {
	create: "+",
	update: "→",
	delete: "×",
	get: "›",
	list: "☰",
	clear: "∅",
};

const VALID_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
	pending: new Set(["in_progress", "completed", "deleted"]),
	in_progress: new Set(["pending", "completed", "deleted"]),
	completed: new Set(["deleted"]),
	deleted: new Set(),
};

function isTransitionValid(from: TaskStatus, to: TaskStatus): boolean {
	if (from === to) return true;
	return VALID_TRANSITIONS[from].has(to);
}

// ---------------------------------------------------------------------------
// Dependency graph helpers
// ---------------------------------------------------------------------------

function detectCycle(tasks: readonly Task[], taskId: number, newBlockedBy: readonly number[]): boolean {
	const edges = new Map<number, number[]>();
	for (const t of tasks) {
		if (t.id === taskId) {
			const merged = new Set([...(t.blockedBy ?? []), ...newBlockedBy]);
			edges.set(t.id, [...merged]);
		} else {
			edges.set(t.id, t.blockedBy ? [...t.blockedBy] : []);
		}
	}
	const visiting = new Set<number>();
	const visited = new Set<number>();
	const hasCycle = (node: number): boolean => {
		if (visiting.has(node)) return true;
		if (visited.has(node)) return false;
		visiting.add(node);
		for (const nb of edges.get(node) ?? []) {
			if (hasCycle(nb)) return true;
		}
		visiting.delete(node);
		visited.add(node);
		return false;
	};
	for (const node of edges.keys()) {
		if (hasCycle(node)) return true;
	}
	return false;
}

/** task id → ids of non-deleted tasks that depend on it. */
function deriveBlocks(tasks: readonly Task[]): Map<number, number[]> {
	const blocks = new Map<number, number[]>();
	for (const t of tasks) {
		if (t.status === "deleted") continue;
		for (const dep of t.blockedBy ?? []) {
			const arr = blocks.get(dep) ?? [];
			arr.push(t.id);
			blocks.set(dep, arr);
		}
	}
	return blocks;
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

function selectVisible(state: TaskState): Task[] {
	return state.tasks.filter((t) => t.status !== "deleted");
}

function selectCounts(state: TaskState) {
	const visible = selectVisible(state);
	return {
		total: visible.length,
		pending: visible.filter((t) => t.status === "pending").length,
		inProgress: visible.filter((t) => t.status === "in_progress").length,
		completed: visible.filter((t) => t.status === "completed").length,
	};
}

function selectByStatus(state: TaskState) {
	const visible = selectVisible(state);
	return {
		pending: visible.filter((t) => t.status === "pending"),
		inProgress: visible.filter((t) => t.status === "in_progress"),
		completed: visible.filter((t) => t.status === "completed"),
	};
}

// ---------------------------------------------------------------------------
// Reducer — pure (state, action, params) → (state, op)
// ---------------------------------------------------------------------------

type Op =
	| { kind: "create"; taskId: number }
	| { kind: "update"; id: number; fromStatus: TaskStatus; toStatus: TaskStatus }
	| { kind: "delete"; id: number; subject: string }
	| { kind: "list"; statusFilter?: TaskStatus; includeDeleted: boolean }
	| { kind: "get"; task: Task }
	| { kind: "clear"; count: number }
	| { kind: "error"; message: string };

interface ApplyResult {
	state: TaskState;
	op: Op;
}

function errorResult(state: TaskState, message: string): ApplyResult {
	return { state, op: { kind: "error", message } };
}

function normalizeSubject(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function normalizeActiveForm(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/** Validate and dedupe a list of task ids; null when any entry is invalid. */
function normalizeIds(value: unknown): number[] | null {
	if (!Array.isArray(value)) return null;
	const ids: number[] = [];
	for (const item of value) {
		if (typeof item !== "number" || !Number.isInteger(item) || item < 1) return null;
		if (!ids.includes(item)) ids.push(item);
	}
	return ids;
}

/** T-3: transitioning into in_progress/completed requires all blockers completed. */
function checkBlockersForTransition(tasks: readonly Task[], blockedBy: readonly number[]): string | undefined {
	const outstanding: string[] = [];
	for (const dep of blockedBy) {
		const depTask = tasks.find((t) => t.id === dep);
		if (!depTask || depTask.status === "deleted") {
			outstanding.push(`#${dep} (missing or deleted)`);
			continue;
		}
		if (depTask.status !== "completed") outstanding.push(`#${dep} (${depTask.status})`);
	}
	if (outstanding.length === 0) return undefined;
	return `blocked by unfinished dependencies: ${outstanding.join(", ")}`;
}

/** T-2: at most one non-deleted task may be in_progress at a time. */
function findOtherInProgress(tasks: readonly Task[], selfId: number): Task | undefined {
	return tasks.find((t) => t.status === "in_progress" && t.id !== selfId);
}

function applyMutation(state: TaskState, action: TaskAction, params: Record<string, unknown>): ApplyResult {
	switch (action) {
		case "create": {
			const subject = normalizeSubject(params.subject);
			if (!subject) return errorResult(state, "subject required for create");
			// Create always starts pending — reject a status instead of silently
			// ignoring it (the model would believe the task has that status).
			if (params.status !== undefined) {
				return errorResult(state, "status is not valid for create; new tasks always start as pending");
			}
			// 附加: dedupe blockedBy ids on create (the schema's uniqueItems
				// already rejects duplicates on the model path; direct callers get dedupe).
			const blockedBy = params.blockedBy !== undefined ? normalizeIds(params.blockedBy) : [];
			if (blockedBy === null) {
				return errorResult(state, "blockedBy must be an array of positive integer task ids");
			}
			for (const dep of blockedBy) {
				const depTask = state.tasks.find((t) => t.id === dep);
				if (!depTask) return errorResult(state, `blockedBy: #${dep} not found`);
				if (depTask.status === "deleted") return errorResult(state, `blockedBy: #${dep} is deleted`);
			}
			const newTask: Task = { id: state.nextId, subject, status: "pending" };
			if (params.description) newTask.description = params.description as string;
			if (params.activeForm) newTask.activeForm = normalizeActiveForm(params.activeForm);
			if (blockedBy.length) newTask.blockedBy = blockedBy;
			return {
				state: { tasks: [...state.tasks, newTask], nextId: state.nextId + 1 },
				op: { kind: "create", taskId: newTask.id },
			};
		}

		case "update": {
			if (params.id === undefined) return errorResult(state, "id required for update");
			const idx = state.tasks.findIndex((t) => t.id === params.id);
			if (idx === -1) return errorResult(state, `#${params.id} not found`);
			const current = state.tasks[idx];

			// T-8: deleted tombstones are immutable; there is no restore
			// action (by design), so reject every mutation.
			if (current.status === "deleted") {
				return errorResult(state, `#${current.id} is deleted and cannot be modified`);
			}

			const hasMutation =
				params.subject !== undefined ||
				params.description !== undefined ||
				params.activeForm !== undefined ||
				params.status !== undefined ||
				(params.addBlockedBy && (params.addBlockedBy as unknown[]).length > 0) ||
				(params.removeBlockedBy && (params.removeBlockedBy as unknown[]).length > 0);
			if (!hasMutation) return errorResult(state, "update requires at least one mutable field");

			let newStatus: TaskStatus = current.status;
			if (params.status !== undefined) {
				const target = params.status as TaskStatus;
				if (!isTransitionValid(current.status, target)) {
					return errorResult(state, `illegal transition: ${current.status} → ${target}`);
				}
				// T-4 (fix): update→deleted must pass the same reverse-dependency
				// gate as the delete action, or it would leave dangling blockedBy.
				if (target === "deleted") {
					const dependents = deriveBlocks(state.tasks).get(current.id) ?? [];
					if (dependents.length > 0) {
						return errorResult(
							state,
							`cannot delete #${current.id}: still referenced by ${dependents.map((id) => `#${id}`).join(", ")}; removeBlockedBy first`,
						);
					}
				}
				// T-2: at most one in_progress task at a time.
				if (target === "in_progress" && current.status !== "in_progress") {
					const other = findOtherInProgress(state.tasks, current.id);
					if (other) {
						return errorResult(state, `#${other.id} "${other.subject}" is already in_progress; only one task may be in_progress at a time`);
					}
					// 附加: activeForm is required when entering in_progress.
					const form = params.activeForm !== undefined ? normalizeActiveForm(params.activeForm) : current.activeForm ?? "";
					if (!form) {
						return errorResult(state, "activeForm (non-empty) is required when marking a task in_progress");
					}
				}
				newStatus = target;
			}

			let newBlockedBy = current.blockedBy ? [...current.blockedBy] : [];
			const removeBlockedBy = params.removeBlockedBy as number[] | undefined;
			if (removeBlockedBy?.length) {
				const toRemove = new Set(removeBlockedBy);
				newBlockedBy = newBlockedBy.filter((dep) => !toRemove.has(dep));
			}
			const addBlockedBy = params.addBlockedBy as number[] | undefined;
			if (addBlockedBy?.length) {
				for (const dep of addBlockedBy) {
					if (dep === current.id) return errorResult(state, `cannot block #${current.id} on itself`);
					const depTask = state.tasks.find((t) => t.id === dep);
					if (!depTask) return errorResult(state, `addBlockedBy: #${dep} not found`);
					if (depTask.status === "deleted") return errorResult(state, `addBlockedBy: #${dep} is deleted`);
					if (!newBlockedBy.includes(dep)) newBlockedBy.push(dep);
				}
				if (detectCycle(state.tasks, current.id, newBlockedBy)) {
					return errorResult(state, "addBlockedBy would create a cycle");
				}
			}

			// T-3 (fix): gate status transitions AND dependency edits — a task
			// already in_progress/completed must not gain unfinished blockers.
			const blockedByChanged =
				(params.addBlockedBy !== undefined && (params.addBlockedBy as unknown[]).length > 0) ||
				(params.removeBlockedBy !== undefined && (params.removeBlockedBy as unknown[]).length > 0);
			if (
				(newStatus === "in_progress" || newStatus === "completed") &&
				(current.status !== newStatus || blockedByChanged)
			) {
				const blockerError = checkBlockersForTransition(state.tasks, newBlockedBy);
				if (blockerError) {
					return errorResult(state, `cannot transition to ${newStatus}: ${blockerError}`);
				}
			}

			const updated: Task = { ...current, status: newStatus };
			if (params.subject !== undefined) {
				// T-7: subject updates are trimmed and must stay non-empty.
				const trimmed = normalizeSubject(params.subject);
				if (!trimmed) return errorResult(state, "subject cannot be empty after trimming");
				updated.subject = trimmed;
			}
			if (params.description !== undefined) updated.description = params.description as string;
			if (params.activeForm !== undefined) updated.activeForm = normalizeActiveForm(params.activeForm);
			if (newBlockedBy.length) updated.blockedBy = newBlockedBy;
			else delete updated.blockedBy;

			const newTasks = [...state.tasks];
			newTasks[idx] = updated;
			return {
				state: { tasks: newTasks, nextId: state.nextId },
				op: { kind: "update", id: updated.id, fromStatus: current.status, toStatus: newStatus },
			};
		}

		case "list": {
			return {
				state,
				op: {
					kind: "list",
					includeDeleted: params.includeDeleted === true,
					...(params.status !== undefined ? { statusFilter: params.status as TaskStatus } : {}),
				},
			};
		}

		case "get": {
			if (params.id === undefined) return errorResult(state, "id required for get");
			const task = state.tasks.find((t) => t.id === params.id);
			if (!task) return errorResult(state, `#${params.id} not found`);
			return { state, op: { kind: "get", task } };
		}

		case "delete": {
			if (params.id === undefined) return errorResult(state, "id required for delete");
			const idx = state.tasks.findIndex((t) => t.id === params.id);
			if (idx === -1) return errorResult(state, `#${params.id} not found`);
			const current = state.tasks[idx];
			if (current.status === "deleted") return errorResult(state, `#${current.id} is already deleted`);
			// T-4: never leave dangling blockedBy references behind.
			const dependents = deriveBlocks(state.tasks).get(current.id) ?? [];
			if (dependents.length > 0) {
				return errorResult(
					state,
					`cannot delete #${current.id}: still referenced by ${dependents.map((id) => `#${id}`).join(", ")}; removeBlockedBy first`,
				);
			}
			const updated: Task = { ...current, status: "deleted" };
			const newTasks = [...state.tasks];
			newTasks[idx] = updated;
			return {
				state: { tasks: newTasks, nextId: state.nextId },
				op: { kind: "delete", id: updated.id, subject: updated.subject },
			};
		}

		case "clear": {
			return {
				state: { tasks: [], nextId: 1 },
				op: { kind: "clear", count: state.tasks.length },
			};
		}

		default:
			// Unknown actions (schema bypass) are domain errors, not crashes.
			return errorResult(state, `unknown action: ${String(action)}`);
	}
}

// ---------------------------------------------------------------------------
// Content formatting (for LLM-facing tool result text)
// ---------------------------------------------------------------------------

function formatListLine(t: Task): string {
	const block = t.blockedBy?.length ? ` ⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}` : "";
	const form = t.status === "in_progress" && t.activeForm ? ` (${t.activeForm})` : "";
	return `[${t.status}] #${t.id} ${t.subject}${form}${block}`;
}

function formatGetLines(task: Task, state: TaskState): string {
	const blocks = deriveBlocks(state.tasks).get(task.id) ?? [];
	const lines = [`#${task.id} [${task.status}] ${task.subject}`];
	if (task.description) lines.push(`  description: ${task.description}`);
	if (task.activeForm) lines.push(`  activeForm: ${task.activeForm}`);
	if (task.blockedBy?.length) {
		// 附加: show each dependency's state so a pending blocker is
		// distinguishable from a completed one. The label stays `blockedBy` to
		// match the parameter name the model uses.
		const deps = task.blockedBy
			.map((id) => {
				const dep = state.tasks.find((t) => t.id === id);
				return dep ? `#${id} (${dep.status})` : `#${id} (missing)`;
			})
			.join(", ");
		lines.push(`  blockedBy: ${deps}`);
	}
	if (blocks.length) lines.push(`  blocks: ${blocks.map((id) => `#${id}`).join(", ")}`);
	return lines.join("\n");
}

function formatContent(op: Op, state: TaskState): string {
	switch (op.kind) {
		case "create": {
			const t = state.tasks.find((x) => x.id === op.taskId);
			if (!t) return `Created #${op.taskId}`;
			return `Created #${t.id}: ${t.subject} (pending)`;
		}
		case "update": {
			const transition = op.fromStatus !== op.toStatus ? ` (${op.fromStatus} → ${op.toStatus})` : "";
			return `Updated #${op.id}${transition}`;
		}
		case "delete":
			return `Deleted #${op.id}: ${op.subject}`;
		case "clear":
			return `Cleared ${op.count} tasks`;
		case "list": {
			let view = state.tasks;
			if (!op.includeDeleted) view = view.filter((t) => t.status !== "deleted");
			if (op.statusFilter) view = view.filter((t) => t.status === op.statusFilter);
			return view.length === 0 ? "No tasks" : view.map(formatListLine).join("\n");
		}
		case "get":
			return formatGetLines(op.task, state);
		case "error":
			return `Error: ${op.message}`;
	}
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const TodoParams = Type.Object({
	action: StringEnum(["create", "update", "list", "get", "delete", "clear"] as const),
	subject: Type.Optional(Type.String({ description: "Task subject line (required for create)", maxLength: 200 })),
	description: Type.Optional(Type.String({ description: "Long-form task description", maxLength: 10_000 })),
	activeForm: Type.Optional(
		Type.String({
			description: "Present-continuous label shown while in_progress (e.g. 'writing tests')",
			maxLength: 120,
		}),
	),
	status: Type.Optional(
		StringEnum(["pending", "in_progress", "completed", "deleted"] as const, {
			description: "Target status (update) or list filter (list)",
		}),
	),
	blockedBy: Type.Optional(
		Type.Array(Type.Integer({ minimum: 1 }), {
			uniqueItems: true,
			description: "Initial blockedBy ids (create only)",
		}),
	),
	addBlockedBy: Type.Optional(
		Type.Array(Type.Integer({ minimum: 1 }), {
			uniqueItems: true,
			description: "Task ids to add to blockedBy (update only, additive merge)",
		}),
	),
	removeBlockedBy: Type.Optional(
		Type.Array(Type.Integer({ minimum: 1 }), {
			uniqueItems: true,
			description: "Task ids to remove from blockedBy (update only)",
		}),
	),
	id: Type.Optional(
		Type.Integer({ description: "Task id (required for update, get, delete)", minimum: 1 }),
	),
	includeDeleted: Type.Optional(
		Type.Boolean({ description: "If true, list includes deleted tasks. Default: false." }),
	),
});

// ---------------------------------------------------------------------------
// Overlay widget — persistent display above the editor
// ---------------------------------------------------------------------------

const WIDGET_KEY = "todo-overlay";
const MAX_WIDGET_LINES = 12;

interface WidgetRenderCache {
	width: number;
	generation: number;
	lines: string[];
}

class TodoOverlay {
	private uiCtx: ExtensionUIContext | undefined;
	private widgetRegistered = false;
	private tui: TUI | undefined;
	private currentState: TaskState = { tasks: [], nextId: 1 };
	private theme: Theme | undefined;
	// Two-phase auto-hide: completed tasks stay visible until the next agent
	// turn starts, then disappear. When all tasks are hidden, the widget unmounts.
	private completedTaskIdsPendingHide = new Set<number>();
	private hiddenCompletedTaskIds = new Set<number>();
	// T-6: invalidate() only clears this cache; lifecycle stays with update()/dispose().
	private cache: WidgetRenderCache | undefined;
	private generation = 0;

	setUICtx(ctx: ExtensionUIContext | undefined): void {
		if (ctx !== this.uiCtx) {
			this.uiCtx = ctx;
			this.widgetRegistered = false;
			this.tui = undefined;
			this.cache = undefined;
		}
	}

	resetCompletedDisplayState(): void {
		this.completedTaskIdsPendingHide.clear();
		this.hiddenCompletedTaskIds.clear();
	}

	hideCompletedTasksFromPreviousTurn(): void {
		if (this.completedTaskIdsPendingHide.size === 0) return;
		for (const id of this.completedTaskIdsPendingHide) {
			this.hiddenCompletedTaskIds.add(id);
		}
		this.completedTaskIdsPendingHide.clear();
		this.generation += 1;
		this.tui?.requestRender();
	}

	/** Overlay-visible tasks: non-deleted, minus hidden completed. */
	private selectOverlayVisible(): Task[] {
		return this.currentState.tasks.filter(
			(t) => t.status !== "deleted" && !(t.status === "completed" && this.hiddenCompletedTaskIds.has(t.id)),
		);
	}

	/** Sync hidden-ID sets with current task state (handles replay/reconstruction). */
	private syncHiddenSets(): void {
		const completedIds = new Set(this.currentState.tasks.filter((t) => t.status === "completed").map((t) => t.id));
		for (const id of this.completedTaskIdsPendingHide) {
			if (!completedIds.has(id)) this.completedTaskIdsPendingHide.delete(id);
		}
		for (const id of this.hiddenCompletedTaskIds) {
			if (!completedIds.has(id)) this.hiddenCompletedTaskIds.delete(id);
		}
	}

	update(nextState: TaskState): void {
		if (!this.uiCtx) return;
		this.currentState = nextState;
		this.syncHiddenSets();
		this.generation += 1;
		const visible = this.selectOverlayVisible();
		if (visible.length === 0) {
			// T-6: reconcile — when nothing is visible the widget is really
			// unmounted, not just marked registered=false.
			if (this.widgetRegistered) {
				this.uiCtx.setWidget(WIDGET_KEY, undefined);
				this.widgetRegistered = false;
				this.tui = undefined;
				this.cache = undefined;
			}
			return;
		}

		if (!this.widgetRegistered) {
			this.uiCtx.setWidget(
				WIDGET_KEY,
				(tui: TUI, theme: Theme): Component => {
					this.tui = tui;
					this.theme = theme;
					return {
						render: (width: number) => this.renderWidget(width),
						// T-6: invalidate only drops the render cache; it must
						// not unregister the widget.
						invalidate: () => {
							this.cache = undefined;
						},
					};
				},
				{ placement: "aboveEditor" },
			);
			this.widgetRegistered = true;
		} else {
			this.tui?.requestRender();
		}
	}

	private renderWidget(width: number): string[] {
		const theme = this.theme;
		if (!theme) return [];
		if (this.cache && this.cache.width === width && this.cache.generation === this.generation) {
			return this.cache.lines;
		}
		this.syncHiddenSets();
		const visible = this.selectOverlayVisible();
		if (visible.length === 0) return [];
		const counts = selectCounts(this.currentState);
		const hasActive = counts.pending > 0 || counts.inProgress > 0;
		const truncate = (line: string) => truncateToWidth(line, width, "…");

		const icon = hasActive ? "●" : "○";
		const color = hasActive ? "accent" : "dim";
		const heading = truncate(
			`${theme.fg(color, icon)} ${theme.fg(color, `Todos (${counts.completed}/${counts.total})`)}`,
		);

		const lines: string[] = [heading];
		const maxBody = MAX_WIDGET_LINES - 1;
		const showIds = visible.some((t) => t.blockedBy && t.blockedBy.length > 0);

		// T-5: active tasks first — every non-completed task beats completed
		// ones for screen space, and in_progress beats pending.
		let bodyTasks: Task[];
		let hiddenExtra = 0;
		if (visible.length <= maxBody) {
			bodyTasks = visible;
		} else {
			const inProgress = visible.filter((t) => t.status === "in_progress");
			const pending = visible.filter((t) => t.status === "pending");
			const completed = visible.filter((t) => t.status === "completed");
			// Reserve one line for the "+N more" footer so the widget stays
			// within MAX_WIDGET_LINES (heading + body + footer).
			bodyTasks = [...inProgress, ...pending, ...completed].slice(0, maxBody - 1);
			hiddenExtra = visible.length - bodyTasks.length;
		}

		for (let i = 0; i < bodyTasks.length; i++) {
			const t = bodyTasks[i];
			const isLast = i === bodyTasks.length - 1 && hiddenExtra === 0;
			const prefix = isLast ? "└─" : "├─";
			lines.push(truncate(`${theme.fg("dim", prefix)} ${formatOverlayLine(t, theme, showIds)}`));
		}

		if (hiddenExtra > 0) {
			lines.push(truncate(`${theme.fg("dim", "└─")} ${theme.fg("dim", `+${hiddenExtra} more`)}`));
		}

		// Track displayed completed tasks → mark for hiding on next agent turn.
		for (const t of bodyTasks) {
			if (t.status === "completed" && !this.completedTaskIdsPendingHide.has(t.id) && !this.hiddenCompletedTaskIds.has(t.id)) {
				this.completedTaskIdsPendingHide.add(t.id);
			}
		}

		this.cache = { width, generation: this.generation, lines };
		return lines;
	}

	dispose(): void {
		if (this.uiCtx) this.uiCtx.setWidget(WIDGET_KEY, undefined);
		this.widgetRegistered = false;
		this.tui = undefined;
		this.uiCtx = undefined;
		this.cache = undefined;
	}
}

function overlayStatusGlyph(status: TaskStatus, theme: Theme): string {
	switch (status) {
		case "pending":
			return theme.fg("dim", "○");
		case "in_progress":
			return theme.fg("warning", "◐");
		case "completed":
			return theme.fg("success", "✓");
		case "deleted":
			return theme.fg("error", "✗");
	}
}

function formatOverlayLine(t: Task, theme: Theme, showId: boolean): string {
	const glyph = overlayStatusGlyph(t.status, theme);
	const subjectColor = t.status === "completed" || t.status === "deleted" ? "dim" : "text";
	let subject = theme.fg(subjectColor, t.subject);
	if (t.status === "completed") subject = theme.strikethrough(subject);
	let line = glyph;
	if (showId) line += ` ${theme.fg("accent", `#${t.id}`)}`;
	line += ` ${subject}`;
	if (t.status === "in_progress" && t.activeForm) {
		line += ` ${theme.fg("dim", `(${t.activeForm})`)}`;
	}
	if (t.blockedBy && t.blockedBy.length > 0) {
		line += ` ${theme.fg("dim", `⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}`)}`;
	}
	return line;
}

// ---------------------------------------------------------------------------
// /todos command UI component
// ---------------------------------------------------------------------------

class TodoListComponent {
	private state: TaskState;
	private theme: Theme;
	private onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(state: TaskState, theme: Theme, onClose: () => void) {
		this.state = state;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const th = this.theme;
		const counts = selectCounts(this.state);
		const groups = selectByStatus(this.state);

		lines.push("");
		const title = th.fg("accent", " Todos ");
		const headerLine =
			th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 10)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		if (counts.total === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No todos yet. Ask the agent to add some!")}`, width));
		} else {
			const headerParts: string[] = [];
			if (counts.completed > 0) headerParts.push(`${counts.completed}/${counts.total} completed`);
			if (counts.inProgress > 0) headerParts.push(`${counts.inProgress} in progress`);
			if (counts.pending > 0) headerParts.push(`${counts.pending} pending`);
			lines.push(truncateToWidth(`  ${th.fg("muted", headerParts.join(" · "))}`, width));
			lines.push("");

			if (groups.pending.length > 0) {
				lines.push(truncateToWidth(`  ${th.fg("dim", "── Pending ──")}`, width));
				for (const t of groups.pending) {
					lines.push(truncateToWidth(formatCommandLine(t, "○", th), width));
				}
			}
			if (groups.inProgress.length > 0) {
				lines.push(truncateToWidth(`  ${th.fg("warning", "── In Progress ──")}`, width));
				for (const t of groups.inProgress) {
					lines.push(truncateToWidth(formatCommandLine(t, "◐", th), width));
				}
			}
			if (groups.completed.length > 0) {
				lines.push(truncateToWidth(`  ${th.fg("success", "── Completed ──")}`, width));
				for (const t of groups.completed) {
					lines.push(truncateToWidth(formatCommandLine(t, "✓", th), width));
				}
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width));
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

function formatCommandLine(t: Task, glyph: string, theme: Theme): string {
	const form = t.status === "in_progress" && t.activeForm ? ` (${t.activeForm})` : "";
	const block = t.blockedBy?.length ? `    ⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}` : "";
	const subjectColor = t.status === "completed" ? "dim" : "text";
	const subject = t.status === "completed" ? theme.strikethrough(theme.fg(subjectColor, t.subject)) : theme.fg(subjectColor, t.subject);
	return `  ${glyph} ${theme.fg("accent", `#${t.id}`)} ${subject}${form}${block}`;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

function isStaleCtxError(e: unknown): boolean {
	return /stale after session replacement/.test(String(e));
}

export default function (pi: ExtensionAPI) {
	// In-memory state (reconstructed from session on load)
	let state: TaskState = { tasks: [], nextId: 1 };
	const overlay = new TodoOverlay();

	const reconstructState = (ctx: ExtensionContext) => {
		let result: TaskState = { tasks: [], nextId: 1 };
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;
			const details = msg.details as TaskDetails | undefined;
			if (details && Array.isArray(details.tasks) && typeof details.nextId === "number") {
				result = { tasks: details.tasks.map((t) => ({ ...t })), nextId: details.nextId };
			}
		}
		state = result;
	};

	// Session lifecycle
	pi.on("session_start", async (_event, ctx) => {
		reconstructState(ctx);
		overlay.resetCompletedDisplayState();
		if (ctx.hasUI) {
			overlay.setUICtx(ctx.ui);
			overlay.update(state);
		}
	});

	pi.on("session_compact", async (_event, ctx) => {
		try {
			reconstructState(ctx);
		} catch (e) {
			if (!isStaleCtxError(e)) throw e;
		}
		overlay.resetCompletedDisplayState();
		overlay.update(state);
	});

	pi.on("session_tree", async (_event, ctx) => {
		try {
			reconstructState(ctx);
		} catch (e) {
			if (!isStaleCtxError(e)) throw e;
		}
		overlay.resetCompletedDisplayState();
		overlay.update(state);
	});

	pi.on("session_shutdown", async () => {
		overlay.dispose();
	});

	// Update overlay after each todo tool call (successful ones only: domain
	// errors now throw, so isError carries the reducer's verdict).
	pi.on("tool_execution_end", async (event) => {
		if (event.toolName !== "todo" || event.isError) return;
		overlay.update(state);
	});

	// When the agent starts a new turn, hide completed tasks from the previous turn
	pi.on("agent_start", async () => {
		overlay.hideCompletedTasksFromPreviousTurn();
	});

	// Register the todo tool
	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Manage a task list for tracking multi-step progress. Actions: create (new task), update (change status/fields/dependencies), list (all tasks, optionally filtered by status), get (single task details), delete (tombstone), clear (reset all). Status: pending → in_progress → completed, plus deleted tombstone. Use this to plan and track multi-step work.",
		promptSnippet: "Manage a task list to track multi-step progress",
		promptGuidelines: [
			"Use `todo` for complex work with 3+ steps, when the user gives you a list of tasks, or immediately after receiving new instructions to capture requirements. Skip it for single trivial tasks and purely conversational requests.",
			"When starting any task, mark it in_progress BEFORE beginning work. Mark it completed IMMEDIATELY when done — never batch completions. Exactly one task should be in_progress at a time.",
			"Never mark a task completed if tests are failing, the implementation is partial, or you hit unresolved errors — keep it in_progress and create a new task for the blocker instead.",
			"Task status is a 4-state machine: pending → in_progress → completed, plus deleted as a tombstone. Pass activeForm (present-continuous label, e.g. 'researching existing tool') when marking in_progress.",
			"Use blockedBy to express dependencies (A is blocked by B). On create, pass blockedBy as the initial set. On update, use addBlockedBy / removeBlockedBy (additive merge — do not resend the full array). Cycles are rejected.",
			"list hides tombstoned (deleted) tasks by default; pass includeDeleted:true to see them. Pass status to filter by a single status.",
			"Subject must be short and imperative (e.g. 'Research existing tool'); description is for long-form detail. activeForm is a present-continuous label shown while in_progress.",
		],
		parameters: TodoParams,
		// T-1: shared mutable state + parallel execution would race.
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const result = applyMutation(state, params.action, params as Record<string, unknown>);
			// T-9: domain errors throw so the tool result carries
			// isError=true; state is only advanced on success.
			if (result.op.kind === "error") throw new Error(result.op.message);
			state = result.state;
			const text = formatContent(result.op, state);
			const details: TaskDetails = {
				action: params.action,
				params: params as Record<string, unknown>,
				tasks: state.tasks,
				nextId: state.nextId,
			};
			return { content: [{ type: "text", text }], details };
		},

		renderCall(args, theme, _context) {
			const glyph = ACTION_GLYPH[args.action as TaskAction] ?? args.action;
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", glyph);

			// No mutable-state reads here: args are the only source.
			if (args.action === "create" && args.subject) {
				text += ` ${theme.fg("dim", args.subject as string)}`;
			} else if (
				(args.action === "update" || args.action === "get" || args.action === "delete") &&
				args.id !== undefined
			) {
				text += ` ${theme.fg("accent", `#${args.id}`)}`;
			} else if (args.action === "list" && args.status) {
				text += ` ${theme.fg("muted", STATUS_LABEL[args.status as TaskStatus] ?? (args.status as string))}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _opts, theme, _context) {
			const details = result.details as TaskDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			let status: TaskStatus | undefined;
			switch (details.action) {
				case "create":
					status = details.tasks[details.tasks.length - 1]?.status;
					break;
				case "update": {
					const params = details.params;
					status = (params.status as TaskStatus) ?? details.tasks.find((t) => t.id === params.id)?.status;
					break;
				}
				case "delete":
					status = details.tasks.find((t) => t.id === details.params.id)?.status;
					break;
				case "list":
				case "get":
				case "clear":
					break;
			}
			if (status) {
				return new Text(
					theme.fg(STATUS_COLOR[status], `${STATUS_GLYPH[status]} ${STATUS_LABEL[status]}`),
					0,
					0,
				);
			}
			return new Text(theme.fg("success", "✓"), 0, 0);
		},
	});

	// Register /todos command
	pi.registerCommand("todos", {
		description: "Show all todos on the current branch, grouped by status",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				// Non-TUI: output as notification
				const visible = selectVisible(state);
				if (visible.length === 0) {
					ctx.ui.notify("No todos yet. Ask the agent to add some!", "info");
					return;
				}
				const counts = selectCounts(state);
				const groups = selectByStatus(state);
				const headerParts: string[] = [];
				if (counts.completed > 0) headerParts.push(`${counts.completed}/${counts.total} completed`);
				if (counts.inProgress > 0) headerParts.push(`${counts.inProgress} in progress`);
				if (counts.pending > 0) headerParts.push(`${counts.pending} pending`);
				const lines: string[] = [headerParts.join(" · ")];
				if (groups.pending.length > 0) {
					lines.push("── Pending ──");
					for (const t of groups.pending) lines.push(`  ○ #${t.id} ${t.subject}`);
				}
				if (groups.inProgress.length > 0) {
					lines.push("── In Progress ──");
					for (const t of groups.inProgress) lines.push(`  ◐ #${t.id} ${t.subject}`);
				}
				if (groups.completed.length > 0) {
					lines.push("── Completed ──");
					for (const t of groups.completed) lines.push(`  ✓ #${t.id} ${t.subject}`);
				}
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new TodoListComponent(state, theme, () => done());
			});
		},
	});
}
