/**
 * pi-plan — PLAN/EXEC modes with a thin silent gate.
 *
 * New sessions start in PLAN (read-only). The user never has to opt in.
 *
 *   /plan :  PLAN (read-only) → EXEC (implement approved plan) → default → PLAN
 *
 * After the exec run ends, the user's next message returns the session to
 * PLAN — ready for the next feature/iteration.
 *
 * Gate (PLAN only, silent — no confirm dialogs, never halts the phase):
 *   write / edit / Agent / SubagentWorkflow : hard block
 *   everything else (including all bash)    : allowed — the PLAN persona
 *                                             enforces read-only + no downloads
 *
 * Flow: the model calls show_plan with the settled plan. The plan pops up in
 * the transcript as a readable plan view (a TUI-only entry — never sent to the
 * LLM) and the user gets a two-option selector — Execute / Continue planning
 * (arrow keys + enter, active option in its own token color, framed by
 * PLAN-blue dividers). Nothing is written to disk: the plan lives in memory
 * and in the session transcript.
 *
 * The token line also shows the active hermes profile to the left
 * (e.g. `ADMIN · 2 PLAN`) when one is selected, read from the
 * globalThis.__piHermesSkills registry published by pi-hermes-skills.
 *
 * EXEC starts on a clean context: the context filter slices every request to
 * the kickoff message (exec instructions + full plan) and after, so the
 * executor implements the plan as written instead of re-litigating the
 * planning chat.
 *
 * State is in-memory by design: restart / /new / /resume / /reload → PLAN.
 * On resume the held plan is re-found from the last show_plan call in the
 * session transcript (legacy plan files on disk still work as a fallback).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Markdown, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const PLANS_DIR = join(homedir(), ".pi", "agent", "scratch", "plans");

// Token colors: white text on colored background. Calm per user preference.
const PLAN_COLOR = { h: 215, s: 0.5, l: 0.6 }; // calm blue
const EXEC_COLOR = { h: 150, s: 0.45, l: 0.44 }; // calm green
type Rgb = { kind: "rgb"; r: number; g: number; b: number };
type HermesToken = {
	profile: string;
	skillCount: number;
	rgb: Rgb | null;
	soft: Rgb | null;
	listeners: Set<() => void>;
};
// Same-process registry published by pi-hermes-skills (lazy, so load order is
// irrelevant). pi-plan renders the active profile to the left of the mode tag.
function hermesRegistry(): HermesToken {
	const g = globalThis as Record<string, unknown>;
	g.__piHermesSkills ??= { profile: "", skillCount: 0, rgb: null, soft: null, listeners: new Set<() => void>() };
	return g.__piHermesSkills as HermesToken;
}
const WHITE: Rgb = { kind: "rgb", r: 255, g: 255, b: 255 };
const INACTIVE: Rgb = { kind: "rgb", r: 130, g: 130, b: 130 }; // dimmed selector option

// The only tools the PLAN gate still stops — code editing and delegation.
// Bash and everything else runs; the persona carries the read-only discipline.
const BLOCKED_IN_PLAN = new Set(["write", "edit", "Agent", "SubagentWorkflow"]);

type Mode = "default" | "plan" | "exec";

function hslToRgb(h: number, s: number, l: number): Rgb {
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = l - c / 2;
	const [r, g, b] =
		h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
	return { kind: "rgb", r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

// Banner colors (white text on): Execute = EXEC green, Continue Planning = PLAN blue.
// PLAN_BG also frames the plan view and the selector dividers.
const EXEC_BG = hslToRgb(EXEC_COLOR.h, EXEC_COLOR.s, EXEC_COLOR.l);
const PLAN_BG = hslToRgb(PLAN_COLOR.h, PLAN_COLOR.s, PLAN_COLOR.l);

// Newest plan file, optionally restricted to one project. Timestamped names sort chronologically.
function newestPlan(project?: string): string | undefined {
	let files: string[];
	try {
		files = readdirSync(PLANS_DIR);
	} catch {
		return undefined;
	}
	const prefix = project ? `${project}-` : "";
	files = files.filter((f) => f.startsWith(prefix) && f.endsWith(".md")).sort();
	return files.length > 0 ? join(PLANS_DIR, files[files.length - 1]) : undefined;
}

const PLAN_PERSONA = `[PLAN MODE ACTIVE — planning only, nothing gets executed]
You are pair-programming toward a plan, not an implementation.

Hard rules — PLAN mode is read-only (user-enforced, non-negotiable):
- Never edit the codebase. write/edit are blocked, and do not work around them via bash (no redirects, no tee, no sed -i, no edits-through-scripts).
- Never download or install anything: no curl -o / wget, no git clone, no npm/pip/brew/apt installs, no docker pull or run. Nothing may land on disk — not even in scratch or /tmp.
- bash is for read-only inspection only: grep, cat, ls, find, git log/status/diff, service and container status, network lookups.
- An idea that needs writing or downloading to verify (e.g. "install postgres and check it out") is NOT verified in PLAN — record it in the plan as a step with its own verification instead.

Style:
- One recommendation per implementation idea or fix, with a one-line why.
- Asked to compare methodologies: compare fairly at equal depth, then state your pick explicitly labeled as a recommendation — never skew the comparison toward it.
- The user picks a different approach: proceed with the user's choice; note your recommendation in one line, and only when it materially differs.
- Tone: pair programming, junior talking to a senior. Concise. Reasons in one line, not paragraphs.

Writing the plan — a fresh model that never saw this conversation will execute it:
- Self-contained: exact file paths and exact changes; no "as discussed above".
- Concrete steps with minor liberties: each step is one action an executor can do without asking. E.g. "add a favicon <link> to the header of public/index.html", or "replace the MySQL instance with data.json: 1) capture schema + seed rows, 2) define the JSON shape, 3) swap the connection code, 4) verify".
- Imperative, step by step, one action per step, each with a short verification.
- No vague goals, no architecture essays, no open alternatives — the plan commits to one approach.

When the plan is settled and the user agrees:
1. Call show_plan with the full markdown plan. It appears to the user as a readable plan view in the transcript; they choose Execute or Continue planning.
2. If they keep refining, call show_plan again when settled — it replaces the held plan and shows the updated view.`;

function execNote(): string {
	return `[EXEC MODE ACTIVE] Implementing the approved plan below.
The plan is the spec: execute it step by step as written. Minor liberties on implementation detail (names, exact APIs, order of independent steps) are fine — do not re-plan, do not re-decide architecture, do not add or drop steps. Verify each step the way the plan says. If a step is blocked, stop that step and report exactly what is blocked — do not silently redesign.`;
}

export default function piPlan(pi: ExtensionAPI): void {
	let mode: Mode = "plan";
	let sessionPlanContent: string | undefined; // held in memory by show_plan
	// True once any pi-plan custom message exists in this session's transcript.
	// Keeps the per-request context filter a no-op for sessions that never used /plan.
	let hasPlanMessages = false;
	// Latest context that owned a UI render, so the hermes registry listener can
	// re-render the combined token when /hermes changes the profile (it runs in
	// the hermes extension, not here).
	let lastCtx: ExtensionContext | undefined;
	// Re-render the combined token live when the hermes extension changes the
	// profile/skills (it publishes to the registry and calls this listener).
	hermesRegistry().listeners.add(() => {
		if (lastCtx) updateToken(lastCtx);
	});

	function updateToken(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (mode === "default") {
			ctx.ui.setWidget("pi-plan", undefined);
			return;
		}
		const label = mode === "plan" ? "PLAN" : "EXEC";
		const color = mode === "plan" ? PLAN_COLOR : EXEC_COLOR;
		ctx.ui.setWidget(
			"pi-plan",
			(_tui, theme) => {
				// Each pill is self-padded; the plain space between them is the only
				// un-backgrounded gap column.
				const h = hermesRegistry();
				const hermes =
					h.profile && h.rgb && h.soft
						? theme.style(` ${h.profile.toUpperCase()}${h.skillCount > 0 ? ` · ${h.skillCount}` : ""} `, { fg: h.rgb, bg: h.soft }) + " "
						: "";
				return new Text(hermes + theme.style(` ${label} `, { fg: WHITE, bg: hslToRgb(color.h, color.s, color.l) }), 0, 0);
			},
		);
	}

	function setMode(next: Mode, ctx: ExtensionContext): void {
		mode = next;
		updateToken(ctx);
	}

	// Last settled plan in this session's transcript (resumed sessions have no
	// in-memory plan). Matches show_plan and legacy save_plan calls.
	function findHeldPlan(ctx: ExtensionContext): string | undefined {
		const entries = ctx.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i] as { type?: string; message?: { role?: string; content?: unknown } } | null;
			if (!e || e.type !== "message" || e.message?.role !== "assistant" || !Array.isArray(e.message.content)) continue;
			for (const c of e.message.content as { type?: string; name?: string; arguments?: { content?: unknown } }[]) {
				if (c.type === "toolCall" && (c.name === "show_plan" || c.name === "save_plan")) {
					const text = c.arguments?.content;
					if (typeof text === "string" && text.trim()) return text.trimEnd() + "\n";
				}
			}
		}
		return undefined;
	}

	// Legacy fallback only: old plan files from before the no-file flow.
	// Last plans/ path in the transcript → newest for project → newest overall.
	function findPlanPath(ctx: ExtensionContext): string | undefined {
		const entries = ctx.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const m = JSON.stringify(entries[i]).match(/(?:~|\/)[^\s"'`]*scratch\/plans\/[^\s"'`]+\.md/);
			if (m) {
				const p = m[0].startsWith("~") ? join(homedir(), m[0].slice(1)) : m[0];
				if (existsSync(p)) return p;
			}
		}
		return newestPlan(basename(ctx.cwd)) ?? newestPlan();
	}

	// Plan → EXEC: kick off the run with the full plan as the kickoff message.
	// The context filter slices every exec request to kickoff-and-after — the
	// planning conversation is not in the executor's context. Nothing is written
	// to disk: the plan lives in the kickoff (and the session transcript).
	function startExec(ctx: ExtensionContext, content: string): void {
		setMode("exec", ctx);
		ctx.ui.notify("EXEC: implementing the approved plan.", "info");
		// triggerTurn starts the run immediately when idle; while a turn is
		// streaming the followUp is delivered when the current run ends —
		// after the show_plan tool result, so its call/result pair stays intact.
		pi.sendMessage(
			{
				customType: "pi-plan-exec-kickoff",
				display: true,
				content: `${execNote()}\n\n---\n${content}`,
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	}

	// Two-option selector shown by show_plan: Execute / Continue Planning.
	// Active option in its own color — Execute green, Continue Planning blue; inactive dimmed.
	// Banner padded to the longest label; framed by full-width PLAN-blue ─ dividers above and below.
	// Arrows move, enter selects; Escape = continue planning (model ends its turn and waits).
	function choosePlanAction(ctx: ExtensionContext): Promise<"execute" | "continue"> {
		const options = [
			{ value: "execute", label: "Execute" },
			{ value: "continue", label: "Continue Planning" },
		] as const;
		// Equal-length banners: pad the active option to the longest label.
		const labelW = Math.max(...options.map((o) => visibleWidth(o.label)));
		return ctx.ui.custom<"execute" | "continue">((tui, theme, keybindings, done) => {
			let selected = 0;
			let cachedWidth: number | undefined;
			let cachedLines: string[] | undefined;
			const invalidate = () => {
				cachedWidth = undefined;
				cachedLines = undefined;
			};
			return {
				render(width: number): string[] {
					if (cachedLines && cachedWidth === width) return cachedLines;
					cachedWidth = width;
					cachedLines = [
						theme.style("─".repeat(width), { fg: PLAN_BG }),
						...options.map((o, i) => {
							const active = i === selected;
							const pad = active ? " ".repeat(Math.max(0, labelW - visibleWidth(o.label))) : "";
							return active
								? theme.style(`> ${o.label}${pad}`, { fg: WHITE, bg: o.value === "execute" ? EXEC_BG : PLAN_BG })
								: theme.style(`  ${o.label}`, { fg: INACTIVE });
						}),
						theme.style("─".repeat(width), { fg: PLAN_BG }),
					].map((line) => truncateToWidth(line, width));
					return cachedLines;
				},
				handleInput(data: string): void {
					if (keybindings.matches(data, "tui.select.up")) {
						selected = (selected + options.length - 1) % options.length;
					} else if (keybindings.matches(data, "tui.select.down")) {
						selected = (selected + 1) % options.length;
					} else if (keybindings.matches(data, "tui.select.confirm")) {
						done(options[selected].value);
						return;
					} else if (keybindings.matches(data, "tui.select.cancel")) {
						done("continue");
						return;
					} else {
						return;
					}
					invalidate();
					tui.requestRender();
				},
				invalidate,
			};
		});
	}

	pi.registerCommand("plan", {
		description: "Cycle modes: PLAN (read-only) → EXEC (implement the plan) → default → PLAN",
		handler: async (_args, ctx) => {
			lastCtx = ctx;
			if (mode === "exec") {
				setMode("default", ctx);
				ctx.ui.notify("EXEC → default.", "info");
				return;
			}
			if (mode === "default") {
				setMode("plan", ctx);
				ctx.ui.notify("PLAN mode: read-only. /plan again once the plan is settled.", "info");
				return;
			}
			// plan → exec: held plan → last show_plan in the transcript → legacy plan files.
			if (sessionPlanContent) {
				startExec(ctx, sessionPlanContent);
				return;
			}
			const held = findHeldPlan(ctx);
			if (held) {
				sessionPlanContent = held;
				startExec(ctx, held);
				return;
			}
			const path = findPlanPath(ctx);
			if (!path) {
				ctx.ui.notify("No plan found. Settle a plan — the model calls show_plan — then /plan again.", "error");
				return;
			}
			let content: string;
			try {
				content = readFileSync(path, "utf8");
			} catch {
				ctx.ui.notify(`Plan unreadable: ${path}`, "error");
				return;
			}
			startExec(ctx, content);
		},
	});

	pi.registerTool({
		name: "show_plan",
		label: "Show Plan",
		description:
			"Show the settled plan to the user as a readable plan view in the transcript, then offer Execute or Continue planning. " +
			"Call it once the plan is complete and the user has agreed; repeat calls replace the held plan and show the updated view. " +
			"Nothing is written to disk — the plan is held in memory and in the session transcript.",
		parameters: Type.Object({
			content: Type.String({ description: "The full plan in markdown." }),
		}),
		// Must not run concurrently with other tool calls — it blocks on a UI choice.
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (mode !== "plan") {
				return {
					content: [{ type: "text", text: "show_plan is only available in PLAN mode. Use /plan first." }],
					details: {},
					isError: true,
				};
			}
			sessionPlanContent = params.content.trimEnd() + "\n";
			// Plan view: readable and persistent in the transcript, TUI-only —
			// never sent to the LLM (the plan text is already in context via
			// this tool call's arguments).
			pi.appendEntry("pi-plan-planview", { content: sessionPlanContent });
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Plan shown and held in memory (no interactive UI). The user runs /plan to execute it." }],
					details: {},
				};
			}
			const choice = await choosePlanAction(ctx);
			if (choice !== "execute") {
				// Both Escape and Continue Planning mean "the user takes over" — the
				// old "refine and call save_plan again" text made the model re-save on
				// its own, popping the selector back up in a loop.
				return {
					content: [
						{
							type: "text",
							text: "The user is continuing to plan manually (Continue Planning or Esc). The plan is still held in memory. End your turn now: reply with one short line and make no further tool calls. If the user's next message gives feedback on the plan, refine the held plan and call show_plan again.",
						},
					],
					details: {},
				};
			}
			try {
				startExec(ctx, sessionPlanContent);
			} catch (err) {
				return {
					content: [{ type: "text", text: `Execute failed: ${err instanceof Error ? err.message : String(err)}` }],
					details: {},
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: "The user chose Execute — execution is starting. End your turn: reply with one short line and make no further tool calls." }],
				details: {},
			};
		},
	});

	// Plan view: the settled plan as a readable transcript block (TUI-only —
	// never sent to the LLM). Framed by PLAN-blue ─ lines, matching the selector.
	pi.registerEntryRenderer("pi-plan-planview", (entry, _options, theme) => {
		const content = ((entry.data ?? {}) as { content?: string }).content ?? "";
		const md = new Markdown(content, 1, 1, getMarkdownTheme());
		const frame = (w: number) => theme.style("─".repeat(w), { fg: PLAN_BG });
		let cachedWidth: number | undefined;
		let cachedLines: string[] | undefined;
		return {
			render(width: number): string[] {
				if (cachedLines && cachedWidth === width) return cachedLines;
				cachedWidth = width;
				cachedLines = [frame(width), ...md.render(width).map((line) => truncateToWidth(line, width)), frame(width)];
				return cachedLines;
			},
			invalidate(): void {
				cachedWidth = undefined;
				cachedLines = undefined;
				md.invalidate();
			},
		};
	});

	// The gate. PLAN only, and deliberately thin: only code-editing and
	// delegation tools are hard-blocked — silent, no prompt, nothing halts.
	// Bash and all other tools run; the PLAN persona enforces read-only and
	// no downloads (the user's rule: the model may inspect, never mutate).
	pi.on("tool_call", async (event, ctx) => {
		lastCtx = ctx;
		if (mode !== "plan") return;
		if (BLOCKED_IN_PLAN.has(event.toolName)) {
			return { block: true, reason: "PLAN mode — the codebase is read-only; put the change in the plan via show_plan." };
		}
	});

	// Exec run ends → back to PLAN immediately, at settle time. agent_settled is
	// final (no auto-retry/compaction after it) and also fires for aborted runs,
	// so an aborted exec still returns to PLAN. setMode → updateToken, so the
	// widget re-renders now instead of on the next user message.
	pi.on("agent_settled", async (_event, ctx) => {
		lastCtx = ctx;
		if (mode === "exec") {
			setMode("plan", ctx);
			if (ctx.hasUI) ctx.ui.notify("EXEC → PLAN: ready for the next idea.", "info");
		}
	});

	// Persona (PLAN) / exec note (EXEC), injected per user prompt.
	// After an exec run, the user's next message hands back to PLAN (next
	// feature/iteration). The exec kickoff is a custom message — never a flip.
	pi.on("before_agent_start", async (event, ctx) => {
		lastCtx = ctx;
		if (event.messageType !== "user") return;
		const kickoff = (event as { message?: { customType?: string } }).message?.customType === "pi-plan-exec-kickoff";
		if (mode === "exec" && !kickoff) setMode("plan", ctx);
		if (mode === "plan") {
			hasPlanMessages = true;
			return { message: { customType: "pi-plan-persona", content: PLAN_PERSONA, display: false } };
		}
		if (mode === "exec") {
			hasPlanMessages = true;
			return { message: { customType: "pi-plan-exec", content: execNote(), display: false } };
		}
	});

	// EXEC runs on a clean context: keep only the kickoff (exec instructions +
	// plan) and everything after it, so the executor implements the plan as
	// written instead of re-litigating the planning conversation.
	// No kickoff found = the followUp is not delivered yet (its own first
	// request) — pass through, it lands before the next run.
	// Other modes: drop stale mode messages once the mode changes, so an old
	// [PLAN MODE ACTIVE] can't keep steering the model after the gate is off.
	pi.on("context", async (event) => {
		if (mode === "exec") {
			for (let i = event.messages.length - 1; i >= 0; i--) {
				if ((event.messages[i] as { customType?: string }).customType === "pi-plan-exec-kickoff") {
					return { messages: event.messages.slice(i) };
				}
			}
			return;
		}
		if (!hasPlanMessages) return;
		const keep = mode === "plan" ? "pi-plan-persona" : undefined;
		// Blank assistant entries are pi's abort artifact (e.g. Esc in the selector);
		// drop them so the model never sees an empty turn before the next prompt.
		const blank = (m: { role?: string; content?: unknown }) =>
			m.role === "assistant" && Array.isArray(m.content) && m.content.length === 0;
		return {
			messages: event.messages.filter((m) => {
				if (blank(m)) return false;
				const t = (m as { customType?: string }).customType;
				return t !== "pi-plan-persona" && t !== "pi-plan-exec" ? true : t === keep;
			}),
		};
	});

	// In-memory by design: every fresh session (restart, /new, /resume, /reload)
	// lands in PLAN — read-only until the user approves execution.
	// The plan file is still findable by path.
	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		mode = "plan";
		sessionPlanContent = undefined;
		// Resumed sessions may carry pi-plan custom messages from a previous run.
		// One O(n) scan per session (not per request) decides whether the context
		// filter has anything to hide.
		hasPlanMessages = ctx.sessionManager
			.getEntries()
			.some((e) => {
				const t = (e as { customType?: string } | null)?.customType;
				return t === "pi-plan-persona" || t === "pi-plan-exec";
			});
		updateToken(ctx);
	});
}
