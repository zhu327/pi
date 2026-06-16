/**
 * Question Tool - Ask one or more structured questions
 *
 * UI refreshed to use an AskUserQuestion-style boxed dialog with chips,
 * preview split panes, notes/custom text editor, and review submit tab.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface QuestionOption {
	value: string;
	label: string;
	description?: string;
	preview?: string;
}

interface Question {
	id: string;
	label: string;
	prompt: string;
	options: QuestionOption[];
	allowOther: boolean;
	multiSelect?: boolean;
}

interface Answer {
	id: string;
	value: string | string[];
	label: string;
	wasCustom: boolean;
	index?: number;
	notes?: string;
	preview?: string;
}

interface QuestionnaireResult {
	questions: Question[];
	answers: Answer[];
	cancelled: boolean;
	chatRequested?: boolean;
}

type InputMode = "other" | "notes" | null;
type DisplayOption = QuestionOption & { isOther?: boolean };

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const QuestionOptionSchema = Type.Object({
	value: Type.String({ description: "The value returned when selected" }),
	label: Type.String({ description: "Display label for the option (1-5 words, max 60 chars)" }),
	description: Type.Optional(Type.String({ description: "Explanation of what this option means or what will happen if chosen" })),
	preview: Type.Optional(Type.String({ description: "Optional preview content (markdown/code) shown next to options when focused" })),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for this question" }),
	label: Type.Optional(
		Type.String({
			description: "Short contextual label for tab bar, e.g. 'Scope', 'Priority' (defaults to Q1, Q2)",
		}),
	),
	prompt: Type.String({ description: "The complete question to ask the user. Should be clear, specific, and end with a question mark." }),
	options: Type.Optional(Type.Array(QuestionOptionSchema, { description: "Available choices (2-4 options). If omitted, the question is a free-text input." })),
	allowOther: Type.Optional(Type.Boolean({ description: "Allow 'Type something.' fallback (default: true, suppressed when multiSelect or any option has preview)" })),
	multiSelect: Type.Optional(Type.Boolean({ description: "Allow selecting multiple options (default: false)" })),
});

const QuestionnaireParams = Type.Object({
	questions: Type.Array(QuestionSchema, { description: "Questions to ask the user (1-4 questions)" }),
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_QUESTIONS = 4;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;
const RESERVED_LABELS = new Set(["Other", "Other...", "Type something.", "Chat about this", "Next"]);
const OtherLabel = "Type something.";

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

function errorResult(message: string, questions: Question[] = []): { content: { type: "text"; text: string }[]; details: QuestionnaireResult } {
	return {
		content: [{ type: "text", text: message }],
		details: { questions, answers: [], cancelled: true },
	};
}

function formatQuestionsAsText(questions: Question[]): string {
	const lines: string[] = [];
	lines.push("[UI not available — questions presented as text for user to answer]\n");
	for (const q of questions) {
		lines.push(`## ${q.label}: ${q.prompt}`);
		if (q.options.length === 0) {
			lines.push("  (type your answer)");
		} else {
			if (q.multiSelect) lines.push("  (multi-select: choose one or more)");
			for (let i = 0; i < q.options.length; i++) {
				const opt = q.options[i];
				let line = `  ${i + 1}. ${opt.label} (value: ${opt.value})`;
				if (opt.description) line += ` — ${opt.description}`;
				if (opt.preview) line += ` [has preview]`;
				lines.push(line);
			}
			if (q.allowOther) lines.push(`  ${q.options.length + 1}. (type your own answer)`);
		}
		lines.push("");
	}
	lines.push("Ask the user to respond with their selections (e.g. 'Q1: 2, Q2: 1') or type a custom answer.");
	return lines.join("\n");
}

function displayOptions(question: Question): DisplayOption[] {
	const options: DisplayOption[] = [...question.options];
	if (question.allowOther || question.options.length === 0) {
		options.push({ value: "", label: OtherLabel, description: "Enter a custom answer.", isOther: true });
	}
	return options;
}

function wrapOptionIndex(currentIndex: number, delta: number, optionCount: number): number {
	if (optionCount <= 0) return 0;
	return (((currentIndex + delta) % optionCount) + optionCount) % optionCount;
}

function padAnsi(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function wrapInlineItems(items: string[], width: number): string[] {
	const safeWidth = Math.max(1, width);
	const lines: string[] = [];
	let currentLine = "";

	for (const item of items) {
		const fittedItem = visibleWidth(item) > safeWidth ? truncateToWidth(item, safeWidth) : item;
		if (!currentLine) {
			currentLine = fittedItem;
			continue;
		}

		const candidate = `${currentLine} ${fittedItem}`;
		if (visibleWidth(candidate) <= safeWidth) currentLine = candidate;
		else {
			lines.push(currentLine);
			currentLine = fittedItem;
		}
	}

	if (currentLine) lines.push(currentLine);
	return lines.length > 0 ? lines : [""];
}

function answerDisplayText(answer: string): string {
	return answer === "" ? "(empty answer)" : answer;
}

function plainPreviewLines(text: string, width: number): string[] {
	const lines: string[] = [];
	for (const sourceLine of text.split("\n")) {
		const wrapped = wrapTextWithAnsi(sourceLine || " ", Math.max(1, width));
		lines.push(...(wrapped.length > 0 ? wrapped : [""]));
	}
	return lines.length > 0 ? lines : [""];
}

function optionHasPreview(question: Question): boolean {
	return !question.multiSelect && question.options.some((option) => option.preview !== undefined);
}

function missingQuestionLabels(questions: Question[], answers: Map<number, Answer>): string[] {
	return questions.filter((_question, index) => !answers.has(index)).map((question) => question.label);
}

function nextQuestionOrSubmitTab(currentIndex: number, questions: Question[], answers: Map<number, Answer>): number | "submit" {
	for (let offset = 1; offset <= questions.length; offset++) {
		const candidate = (currentIndex + offset) % questions.length;
		if (!answers.has(candidate)) return candidate;
	}
	return questions.length > 1 ? "submit" : currentIndex;
}

function createCancelledResult(questions: Question[], chatRequested = false): QuestionnaireResult {
	return { questions, answers: [], cancelled: true, ...(chatRequested ? { chatRequested: true } : {}) };
}

function buildResult(questions: Question[], answers: Map<number, Answer>): QuestionnaireResult {
	const orderedAnswers: Answer[] = [];
	for (let i = 0; i < questions.length; i++) {
		const answer = answers.get(i);
		if (answer) orderedAnswers.push(answer);
	}
	return { questions, answers: orderedAnswers, cancelled: false };
}

function hasOwnAnswer(answers: Map<number, Answer>, index: number): boolean {
	return answers.has(index);
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function question(pi: ExtensionAPI) {
	pi.registerTool({
		name: "question",
		label: "Question",
		description:
			"Ask the user one or more structured questions during execution. Use when you need to gather preferences, clarify requirements, get decisions, or offer choices. Users can select options, type custom answers, add notes, and chat about questions. Multi-select and preview support available.",
		promptSnippet: `Ask the user up to ${MAX_QUESTIONS} structured questions when requirements are ambiguous`,
		promptGuidelines: [
			`Use question when the user's request is underspecified and you cannot proceed without concrete decisions — group up to ${MAX_QUESTIONS} questions into one invocation.`,
			`For multiple-choice questions, provide ${MIN_OPTIONS}-${MAX_OPTIONS} concise options. Omit options only when a free-text answer is required.`,
			"Do not author reserved labels yourself: Other, Type something., Chat about this, or Next. The UI adds sentinel rows automatically.",
			"Use multiSelect:true only when multiple answers are valid; this suppresses the free-text fallback. Any option preview also suppresses the free-text fallback.",
			"Use option previews for concrete artifacts that benefit from visual comparison, such as mockups, code snippets, diagrams, or configs.",
		],
		parameters: QuestionnaireParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.questions.length === 0) return errorResult("Error: No questions provided");
			if (params.questions.length > MAX_QUESTIONS) return errorResult(`Error: Maximum ${MAX_QUESTIONS} questions allowed`);

			for (const q of params.questions) {
				if (q.multiSelect && (!q.options || q.options.length === 0)) return errorResult("Error: multiSelect questions require options");
				if (q.options && q.options.length > 0 && q.options.length < MIN_OPTIONS) {
					return errorResult(`Error: Options must be omitted or contain ${MIN_OPTIONS}-${MAX_OPTIONS} choices`);
				}
				if (q.options && q.options.length > MAX_OPTIONS) return errorResult(`Error: Maximum ${MAX_OPTIONS} options per question`);
				if (q.options) {
					const seenLabels = new Set<string>();
					for (const opt of q.options) {
						if (RESERVED_LABELS.has(opt.label)) return errorResult(`Error: Reserved label "${opt.label}" not allowed`);
						if (seenLabels.has(opt.label)) return errorResult("Error: Option labels must be unique within a question");
						seenLabels.add(opt.label);
					}
				}
			}

			const questions: Question[] = params.questions.map((q, i) => {
				const options = q.options ?? [];
				const multiSelect = q.multiSelect ?? false;
				const hasPreview = options.some((opt) => !!opt.preview);
				return {
					id: q.id,
					label: q.label || `Q${i + 1}`,
					prompt: q.prompt,
					options,
					allowOther: !multiSelect && !hasPreview && q.allowOther !== false,
					multiSelect,
				};
			});

			if (!ctx.hasUI || !process.stdin.isTTY || !process.stdout.isTTY) {
				const text = formatQuestionsAsText(questions);
				return {
					content: [{ type: "text", text }],
					details: { questions, answers: [], cancelled: false } as QuestionnaireResult,
				};
			}

			let shouldTerminateAfterDialog = false;
			let result: QuestionnaireResult;
			(ctx.ui as any).setWorkingVisible?.(false);
			try {
				result =
					(await ctx.ui.custom<QuestionnaireResult>((tui, theme, _keybindings, done) => {
						let currentTabIndex = 0;
						let optionIndex = 0;
						let submitPickerIndex = 0;
						let inputMode: InputMode = null;
						let pendingEscape = false;
						let showHelp = false;
						let statusMessage = "";
						let cachedLines: string[] | undefined;

						const answers = new Map<number, Answer>();
						const selectedSingle = new Map<number, number>();
						const selectedMulti = new Map<number, Set<number>>();
						const customOtherAnswers = new Map<number, string>();
						const notesByQuestion = new Map<number, string>();
						const emptySelectionWarnings = new Set<number>();

						const editorTheme: EditorTheme = {
							borderColor: (s) => theme.fg("accent", s),
							selectList: {
								selectedPrefix: (t) => theme.fg("accent", t),
								selectedText: (t) => theme.fg("accent", t),
								description: (t) => theme.fg("muted", t),
								scrollInfo: (t) => theme.fg("dim", t),
								noMatch: (t) => theme.fg("warning", t),
							},
						};
						const editor = new Editor(tui, editorTheme);

						function refresh() {
							cachedLines = undefined;
							tui.requestRender();
						}

						const multiQuestion = questions.length > 1;
						const reviewTabIndex = questions.length;

						function currentQuestionIndex(): number {
							return Math.min(currentTabIndex, questions.length - 1);
						}

						function onSubmitTab(): boolean {
							return multiQuestion && currentTabIndex === reviewTabIndex;
						}

						function currentQuestion(): Question {
							return questions[currentQuestionIndex()]!;
						}

						function currentOptions(): DisplayOption[] {
							return displayOptions(currentQuestion());
						}

						function currentMultiSelection(): Set<number> {
							const questionIndex = currentQuestionIndex();
							let selection = selectedMulti.get(questionIndex);
							if (!selection) {
								selection = new Set<number>();
								selectedMulti.set(questionIndex, selection);
							}
							return selection;
						}

						function focusCurrentTab() {
							if (onSubmitTab()) {
								optionIndex = 0;
								return;
							}
							const questionIndex = currentQuestionIndex();
							const options = currentOptions();
							const selected = selectedSingle.get(questionIndex);
							if (selected !== undefined && selected >= 0 && selected < options.length) optionIndex = selected;
							else optionIndex = 0;
						}

						function dismissToChat() {
							shouldTerminateAfterDialog = true;
							done(createCancelledResult(questions, true));
						}

						function answerForOption(option: DisplayOption, index: number, customText?: string): Answer {
							const question = currentQuestion();
							const questionIndex = currentQuestionIndex();
							const notes = notesByQuestion.get(questionIndex);
							if (option.isOther) {
								const text = customText ?? customOtherAnswers.get(questionIndex) ?? "";
								return { id: question.id, value: text, label: text, wasCustom: true, notes };
							}
							return {
								id: question.id,
								value: option.value,
								label: option.label,
								wasCustom: false,
								index: index + 1,
								preview: option.preview,
								notes,
							};
						}

						function moveToNextQuestionOrReview() {
							if (!multiQuestion) {
								done(buildResult(questions, answers));
								return;
							}

							const next = nextQuestionOrSubmitTab(currentQuestionIndex(), questions, answers);
							currentTabIndex = next === "submit" ? reviewTabIndex : next;
							focusCurrentTab();
							submitPickerIndex = 0;
							statusMessage = "";
							refresh();
						}

						function updateCurrentMultiAnswer() {
							const question = currentQuestion();
							const questionIndex = currentQuestionIndex();
							const selection = currentMultiSelection();
							const labels: string[] = [];
							const values: string[] = [];
							for (const index of Array.from(selection).sort((a, b) => a - b)) {
								const option = question.options[index];
								if (option) {
									labels.push(option.label);
									values.push(option.value);
								}
							}

							if (selection.size === 0) {
								answers.delete(questionIndex);
								return;
							}

							answers.set(questionIndex, {
								id: question.id,
								value: values,
								label: labels.join(", "),
								wasCustom: false,
								notes: notesByQuestion.get(questionIndex),
							});
						}

						function saveSingleAnswer(option: DisplayOption) {
							const questionIndex = currentQuestionIndex();
							selectedSingle.set(questionIndex, optionIndex);
							answers.set(questionIndex, answerForOption(option, optionIndex));
							moveToNextQuestionOrReview();
						}

						function saveMultiAnswer() {
							const question = currentQuestion();
							const questionIndex = currentQuestionIndex();
							const selection = currentMultiSelection();
							if (selection.size === 0 && !emptySelectionWarnings.has(questionIndex)) {
								emptySelectionWarnings.add(questionIndex);
								statusMessage = "No options selected. Press Enter again to confirm an empty answer.";
								refresh();
								return;
							}
							if (selection.size === 0) {
								answers.set(questionIndex, { id: question.id, value: [], label: "", wasCustom: false });
							} else {
								updateCurrentMultiAnswer();
							}
							moveToNextQuestionOrReview();
						}

						function startInput(mode: InputMode) {
							inputMode = mode;
							pendingEscape = false;
							statusMessage = mode === "other" ? "Type a custom answer." : "Add a note for the focused option.";
							editor.setText(mode === "other" ? (customOtherAnswers.get(currentQuestionIndex()) ?? "") : (notesByQuestion.get(currentQuestionIndex()) ?? ""));
							refresh();
						}

						editor.onSubmit = (value) => {
							const text = value.trim();
							if (!text) {
								statusMessage = "Input cannot be empty.";
								refresh();
								return;
							}

							const questionIndex = currentQuestionIndex();
							if (inputMode === "other") {
								const options = currentOptions();
								customOtherAnswers.set(questionIndex, text);
								selectedSingle.set(questionIndex, options.length - 1);
								answers.set(questionIndex, answerForOption(options[options.length - 1]!, options.length - 1, text));
								inputMode = null;
								editor.setText("");
								moveToNextQuestionOrReview();
								return;
							}

							if (inputMode === "notes") {
								notesByQuestion.set(questionIndex, text);
								const existing = answers.get(questionIndex);
								if (existing) answers.set(questionIndex, { ...existing, notes: text });
								inputMode = null;
								editor.setText("");
								statusMessage = "Note saved.";
								refresh();
							}
						};

						function confirmFocusedOption() {
							const question = currentQuestion();
							const options = currentOptions();
							const option = options[optionIndex];
							if (!option) return;

							if (option.isOther) {
								startInput("other");
								return;
							}

							if (question.multiSelect) saveMultiAnswer();
							else saveSingleAnswer(option);
						}

						function toggleFocusedMultiOption() {
							const options = currentOptions();
							const option = options[optionIndex];
							if (!option || option.isOther) return;

							const selection = currentMultiSelection();
							if (selection.has(optionIndex)) selection.delete(optionIndex);
							else selection.add(optionIndex);
							updateCurrentMultiAnswer();
							emptySelectionWarnings.delete(currentQuestionIndex());
							statusMessage = "Answer updated.";
							refresh();
						}

						function finishWithAnswers() {
							done(buildResult(questions, answers));
						}

						function handleInput(data: string) {
							if (matchesKey(data, Key.ctrl("c"))) {
								done(createCancelledResult(questions));
								return;
							}

							if (inputMode) {
								if (matchesKey(data, Key.escape)) {
									inputMode = null;
									editor.setText("");
									statusMessage = "";
									refresh();
									return;
								}
								editor.handleInput(data);
								refresh();
								return;
							}

							if (showHelp) {
								showHelp = false;
								refresh();
								return;
							}

							if (matchesKey(data, Key.escape)) {
								if (pendingEscape) {
									done(createCancelledResult(questions));
									return;
								}
								pendingEscape = true;
								statusMessage = "Press Esc again to cancel. Press c to chat about this.";
								refresh();
								return;
							}
							pendingEscape = false;

							if (matchesKey(data, "c")) {
								dismissToChat();
								return;
							}

							const totalTabs = multiQuestion ? questions.length + 1 : questions.length;
							if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
								currentTabIndex = (currentTabIndex + 1) % totalTabs;
								focusCurrentTab();
								submitPickerIndex = 0;
								statusMessage = "";
								refresh();
								return;
							}
							if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
								currentTabIndex = (currentTabIndex - 1 + totalTabs) % totalTabs;
								focusCurrentTab();
								submitPickerIndex = 0;
								statusMessage = "";
								refresh();
								return;
							}

							if (onSubmitTab()) {
								if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
									submitPickerIndex = wrapOptionIndex(submitPickerIndex, -1, 2);
									statusMessage = "";
									refresh();
									return;
								}
								if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
									submitPickerIndex = wrapOptionIndex(submitPickerIndex, 1, 2);
									statusMessage = "";
									refresh();
									return;
								}
								if (matchesKey(data, Key.enter)) {
									if (submitPickerIndex === 1) {
										done(createCancelledResult(questions));
										return;
									}
									const missing = missingQuestionLabels(questions, answers);
									if (missing.length > 0) {
										statusMessage = `Answer remaining questions before submitting: ${missing.join(", ")}`;
										refresh();
										return;
									}
									finishWithAnswers();
									return;
								}
								return;
							}

							const question = currentQuestion();
							const options = currentOptions();

							if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
								optionIndex = wrapOptionIndex(optionIndex, -1, options.length);
								statusMessage = "";
								refresh();
								return;
							}
							if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
								optionIndex = wrapOptionIndex(optionIndex, 1, options.length);
								statusMessage = "";
								refresh();
								return;
							}
							if (matchesKey(data, Key.space)) {
								if (question.multiSelect) toggleFocusedMultiOption();
								return;
							}
							if (matchesKey(data, Key.enter)) {
								confirmFocusedOption();
								return;
							}
							if (matchesKey(data, "o") && displayOptions(question).some((option) => option.isOther)) {
								startInput("other");
								return;
							}
							if (matchesKey(data, "n")) {
								startInput("notes");
								return;
							}
							if (matchesKey(data, Key.question)) {
								showHelp = true;
								refresh();
							}
						}

						function chipBarLines(width: number): string[] {
							const chips = questions.map((question, index) => {
								const answered = hasOwnAnswer(answers, index);
								const active = !onSubmitTab() && index === currentQuestionIndex();
								const marker = answered ? "✓" : "○";
								const raw = `[${marker} ${question.label}]`;
								if (active) return theme.bg("selectedBg", theme.fg("text", raw));
								return theme.fg(answered ? "success" : "muted", raw);
							});

							if (multiQuestion) {
								const raw = "[✓ Submit]";
								chips.push(onSubmitTab() ? theme.bg("selectedBg", theme.fg("text", raw)) : theme.fg(answers.size === questions.length ? "success" : "dim", raw));
							}

							return wrapInlineItems(chips, width);
						}

						function addBoxLine(lines: string[], content: string, innerWidth: number) {
							lines.push(`${theme.fg("accent", "│ ")}${padAnsi(truncateToWidth(content, innerWidth), innerWidth)}${theme.fg("accent", " │")}`);
						}

						function optionMarker(multiSelect: boolean | undefined, focused: boolean, selected: boolean): string {
							if (selected) return multiSelect ? "[X]" : "✓";
							return multiSelect ? "[ ]" : focused ? "●" : "○";
						}

						function optionLines(question: Question, width: number): string[] {
							const options = displayOptions(question);
							const questionIndex = currentQuestionIndex();
							const multiSelection = question.multiSelect ? currentMultiSelection() : new Set<number>();
							const lines: string[] = [];

							for (let i = 0; i < options.length; i++) {
								const option = options[i]!;
								const focused = i === optionIndex;
								const selected = question.multiSelect ? multiSelection.has(i) : selectedSingle.get(questionIndex) === i;
								const marker = optionMarker(question.multiSelect, focused, selected);
								const prefix = focused ? theme.fg("accent", "› ") : "  ";
								const markerAndLabel = `${marker} ${option.label}`;
								const styled = selected ? theme.fg("warning", markerAndLabel) : focused ? theme.fg("accent", markerAndLabel) : theme.fg("text", markerAndLabel);
								lines.push(`${prefix}${styled}`);

								const customOtherSelected = option.isOther === true && selected && customOtherAnswers.has(questionIndex);
								const description = customOtherSelected ? answerDisplayText(customOtherAnswers.get(questionIndex) ?? "") : (option.description ?? "");
								if (description) {
									const descriptionStyle = customOtherSelected ? "warning" : "muted";
									for (const descriptionLine of wrapTextWithAnsi(description, Math.max(1, width - 6))) {
										lines.push(`      ${theme.fg(descriptionStyle, descriptionLine)}`);
									}
								}
							}
							return lines.map((line) => truncateToWidth(line, width));
						}

						function renderPreviewLayout(lines: string[], question: Question, innerWidth: number) {
							const leftWidth = Math.max(24, Math.min(38, Math.floor((innerWidth - 3) * 0.42)));
							const rightWidth = Math.max(12, innerWidth - leftWidth - 3);
							const options = currentOptions();
							const previewText = options[optionIndex]?.preview ?? "No preview for this option.";
							const leftLines = optionLines(question, leftWidth);
							const rightLines = plainPreviewLines(previewText, rightWidth - 2).map((line) => theme.fg("text", line));
							const rows = Math.max(leftLines.length, rightLines.length);

							addBoxLine(lines, `${theme.fg("accent", "Options")}${" ".repeat(Math.max(1, leftWidth - 7))}   ${theme.fg("accent", "Preview")}`, innerWidth);
							for (let i = 0; i < rows; i++) {
								const left = padAnsi(leftLines[i] ?? "", leftWidth);
								const right = padAnsi(rightLines[i] ?? "", rightWidth);
								addBoxLine(lines, `${left} ${theme.fg("muted", "│")} ${right}`, innerWidth);
							}
						}

						function renderSubmitPickerRow(index: number, label: string): string {
							const focused = submitPickerIndex === index;
							const prefix = focused ? theme.fg("accent", "› ") : "  ";
							const row = `${prefix}${index + 1}. ${label}`;
							return focused ? theme.bg("selectedBg", theme.fg("text", row)) : theme.fg(index === 0 ? "success" : "muted", row);
						}

						function renderSubmitTab(lines: string[], innerWidth: number) {
							addBoxLine(lines, theme.fg("accent", theme.bold("Review your answers")), innerWidth);
							addBoxLine(lines, "", innerWidth);

							for (let i = 0; i < questions.length; i++) {
								const question = questions[i]!;
								const answer = answers.get(i);
								if (!answer) continue;
								addBoxLine(lines, `${theme.fg("muted", "• ")}${theme.fg("accent", question.label)}`, innerWidth);
								for (const answerLine of wrapTextWithAnsi(`→ ${answerDisplayText(answer.label)}`, Math.max(1, innerWidth - 2))) {
									addBoxLine(lines, `  ${theme.fg("text", answerLine)}`, innerWidth);
								}
								if (answer.notes) addBoxLine(lines, `  ${theme.fg("muted", `Notes: ${answer.notes}`)}`, innerWidth);
							}

							const missing = missingQuestionLabels(questions, answers);
							if (missing.length > 0) {
								addBoxLine(lines, "", innerWidth);
								addBoxLine(lines, theme.fg("warning", `⚠ Answer remaining questions before submitting: ${missing.join(", ")}`), innerWidth);
							}

							addBoxLine(lines, "", innerWidth);
							addBoxLine(lines, renderSubmitPickerRow(0, "Submit answers"), innerWidth);
							addBoxLine(lines, renderSubmitPickerRow(1, "Cancel / return to chat"), innerWidth);
						}

						function render(width: number): string[] {
							if (cachedLines) return cachedLines;
							const safeWidth = Math.max(40, width);
							const innerWidth = safeWidth - 4;
							const lines: string[] = [];
							const question = currentQuestion();
							const title = onSubmitTab() ? " Review answers " : ` Question ${currentQuestionIndex() + 1}/${questions.length} `;
							const topFill = Math.max(0, safeWidth - visibleWidth(title) - 3);

							lines.push(theme.fg("accent", `╭─${title}${"─".repeat(topFill)}╮`));
							for (const chipLine of chipBarLines(innerWidth)) addBoxLine(lines, chipLine, innerWidth);
							addBoxLine(lines, "", innerWidth);

							if (!onSubmitTab()) {
								for (const qLine of wrapTextWithAnsi(question.prompt, innerWidth)) addBoxLine(lines, theme.fg("text", qLine), innerWidth);
								addBoxLine(lines, "", innerWidth);
							}

							if (onSubmitTab()) {
								renderSubmitTab(lines, innerWidth);
							} else if (showHelp) {
								const helpLines = [
									"↑/↓ or j/k: move focus",
									"space: toggle a multi-select option",
									"enter: confirm this question",
									"o: type a custom answer when available",
									"n: add notes for the focused option/question",
									"c: chat about this",
									"tab / shift+tab: jump between questions",
									"esc then esc: cancel",
									"?: close this help",
								];
								for (const line of helpLines) addBoxLine(lines, theme.fg("muted", line), innerWidth);
							} else if (inputMode) {
								addBoxLine(lines, theme.fg("accent", inputMode === "other" ? "Custom answer:" : "Notes:"), innerWidth);
								for (const editorLine of editor.render(innerWidth)) addBoxLine(lines, editorLine, innerWidth);
							} else if (optionHasPreview(question)) {
								renderPreviewLayout(lines, question, innerWidth);
							} else {
								for (const line of optionLines(question, innerWidth)) addBoxLine(lines, line, innerWidth);
							}

							addBoxLine(lines, "", innerWidth);
							if (statusMessage) addBoxLine(lines, theme.fg("warning", statusMessage), innerWidth);
							const controls = inputMode
								? "Enter submit • Esc back"
								: onSubmitTab()
									? "↑↓/jk move • Enter confirm • Tab questions • Esc Esc cancel"
									: question.multiSelect
										? "↑↓/jk move • Space toggle • Enter confirm • n notes • c chat • ? help"
										: "↑↓/jk move • Enter select • o Other • n notes • c chat • Tab questions • ? help";
							addBoxLine(lines, theme.fg("dim", controls), innerWidth);
							lines.push(theme.fg("accent", `╰${"─".repeat(safeWidth - 2)}╯`));

							cachedLines = lines.map((line) => truncateToWidth(line, safeWidth));
							return cachedLines;
						}

						return {
							render,
							invalidate: () => {
								cachedLines = undefined;
							},
							handleInput,
						};
					})) ?? createCancelledResult(questions);
			} finally {
				(ctx.ui as any).setWorkingVisible?.(true);
			}

			if (result.cancelled) {
				const message = result.chatRequested ? "User chose to chat about the questions" : "User cancelled the question";
				return {
					content: [{ type: "text", text: message }],
					details: result,
					...(shouldTerminateAfterDialog ? { terminate: true } : {}),
				};
			}

			const answerLines = result.answers.map((a) => {
				const qLabel = questions.find((q) => q.id === a.id)?.label || a.id;
				if (a.wasCustom) return `${qLabel}: user wrote: ${a.label}`;
				if (Array.isArray(a.value)) return `${qLabel}: user selected: ${a.label}`;
				return `${qLabel}: user selected: ${a.index}. ${a.label}`;
			});

			return {
				content: [{ type: "text", text: answerLines.join("\n") }],
				details: result,
			};
		},

		renderCall(args, theme, _context) {
			const qs = (args.questions as Question[]) || [];
			const count = qs.length;
			const labels = qs.map((q) => q.label || q.id).join(", ");
			let text = theme.fg("toolTitle", theme.bold("question "));
			text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
			if (labels) text += theme.fg("dim", ` (${truncateToWidth(labels, 40)})`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as QuestionnaireResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.cancelled) {
				const label = details.chatRequested ? "Chat requested" : "Cancelled";
				return new Text(theme.fg("warning", label), 0, 0);
			}
			const lines = details.answers.map((a) => {
				if (a.wasCustom) return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${theme.fg("muted", "(wrote) ")}${a.label}`;
				const display = Array.isArray(a.value) ? a.label : a.index ? `${a.index}. ${a.label}` : a.label;
				return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${display}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
