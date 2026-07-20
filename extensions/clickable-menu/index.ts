/**
 * Clickable TUI Menu Extension
 *
 * Compact centered overlay so the session stays visible around the panel.
 * (Terminals cannot alpha-blend; only unpainted cells show through.)
 *
 * Commands:
 *   /menu              open the menu
 *   /menu reload       reload ~/.pi/agent/clickable-menu.json
 *   /menu debug        toggle click debug logging → /tmp/clickable-menu-debug.log
 *
 * Shortcut: Ctrl+Shift+M
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	Key,
	matchesKey,
	truncateToWidth,
	type Component,
	type OverlayOptions,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";

// ── Types ────────────────────────────────────────────────────────────────────

type NotifyLevel = "info" | "warning" | "error";

type MenuAction =
	| { type: "notify"; message: string; level?: NotifyLevel }
	| { type: "insert"; text: string }
	| { type: "submit"; text: string }
	| { type: "none" };

interface MenuItemConfig {
	id: string;
	label: string;
	description?: string;
	hotkey?: string;
	action?: MenuAction;
}

interface MenuConfig {
	title?: string;
	items: MenuItemConfig[];
}

interface ResolvedItem extends MenuItemConfig {
	action: MenuAction;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: MenuConfig = {
	title: "Quick Menu",
	items: [
		{
			id: "plan",
			label: "Plan mode prompt",
			description: "Insert a planning prompt into the editor",
			hotkey: "p",
			action: {
				type: "insert",
				text: "Explore the codebase and draft a concrete implementation plan for: ",
			},
		},
		{
			id: "review",
			label: "Review recent changes",
			description: "Ask for a focused code review",
			hotkey: "r",
			action: {
				type: "submit",
				text: "Review the recent local changes. Focus on bugs, regressions, and missing tests.",
			},
		},
		{
			id: "tests",
			label: "Suggest tests",
			description: "Ask what tests to add",
			hotkey: "t",
			action: {
				type: "submit",
				text: "What tests should I add for the current change? Be specific about cases and files.",
			},
		},
		{
			id: "hello",
			label: "Hello notification",
			description: "Sanity-check that the menu works",
			hotkey: "h",
			action: {
				type: "notify",
				message: "Clickable menu is working.",
				level: "info",
			},
		},
	],
};

const CONFIG_PATH = join(getAgentDir(), "clickable-menu.json");
const DEBUG_LOG = "/tmp/clickable-menu-debug.log";

// SGR coords + button + any-event motion (1003) for hover highlight.
// Disable in reverse order on close.
const MOUSE_ENABLE = "\x1b[?1006h\x1b[?1000h\x1b[?1003h";
const MOUSE_DISABLE = "\x1b[?1003l\x1b[?1000l\x1b[?1006l";

// Compact centered panel — only the menu covers the session (transparent backdrop).
const OVERLAY: OverlayOptions = {
	anchor: "center",
	width: 58,
	minWidth: 34,
};

let debugEnabled = process.env.PI_MENU_DEBUG === "1";

// ── Config ───────────────────────────────────────────────────────────────────

function loadConfig(): MenuConfig {
	if (!existsSync(CONFIG_PATH)) return structuredClone(DEFAULT_CONFIG);
	try {
		const raw = readFileSync(CONFIG_PATH, "utf-8");
		const parsed = JSON.parse(raw) as MenuConfig;
		if (!parsed || !Array.isArray(parsed.items) || parsed.items.length === 0) {
			return structuredClone(DEFAULT_CONFIG);
		}
		return {
			title: parsed.title?.trim() || DEFAULT_CONFIG.title,
			items: parsed.items.map((item, i) => ({
				id: item.id?.trim() || `item-${i + 1}`,
				label: item.label?.trim() || `Item ${i + 1}`,
				description: item.description?.trim() || undefined,
				hotkey: item.hotkey?.trim()?.slice(0, 1) || undefined,
				action: item.action ?? { type: "none" as const },
			})),
		};
	} catch (err) {
		console.error(`[clickable-menu] Failed to load ${CONFIG_PATH}: ${err}`);
		return structuredClone(DEFAULT_CONFIG);
	}
}

function debugLog(msg: string, extra?: unknown): void {
	if (!debugEnabled) return;
	try {
		const line =
			`${new Date().toISOString()} ${msg}` +
			(extra !== undefined ? ` ${JSON.stringify(extra)}` : "") +
			"\n";
		appendFileSync(DEBUG_LOG, line);
	} catch {
		// ignore
	}
}

// ── Mouse ────────────────────────────────────────────────────────────────────

interface MouseEvent {
	button: number;
	col: number; // 1-based
	row: number; // 1-based
	release: boolean;
	wheel: "up" | "down" | null;
	motion: boolean;
}

function parseMouse(data: string): MouseEvent | null {
	const sgr = data.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
	if (sgr) {
		const button = Number(sgr[1]);
		const col = Number(sgr[2]);
		const row = Number(sgr[3]);
		const release = sgr[4] === "m";
		const motion = (button & 32) !== 0;
		const btn = button & ~32;
		let wheel: MouseEvent["wheel"] = null;
		if ((btn & 64) !== 0) {
			wheel = (btn & 1) === 0 ? "up" : "down";
		}
		return { button: btn, col, row, release, wheel, motion };
	}

	// Legacy X10: ESC [ M Cb Cx Cy
	if (data.length === 6 && data.startsWith("\x1b[M")) {
		const cb = data.charCodeAt(3) - 32;
		const col = data.charCodeAt(4) - 32;
		const row = data.charCodeAt(5) - 32;
		const motion = (cb & 32) !== 0;
		let wheel: MouseEvent["wheel"] = null;
		if ((cb & 64) !== 0) {
			wheel = (cb & 1) === 0 ? "up" : "down";
		}
		return { button: cb & 3, col, row, release: false, wheel, motion };
	}

	return null;
}


function boxLine(
	content: string,
	innerWidth: number,
	theme: Theme,
	selected = false,
): string {
	const body = truncateToWidth(content, innerWidth, "");
	const pad = Math.max(0, innerWidth - visibleWidth(body));
	const filled = body + " ".repeat(pad);
	const edge = theme.fg("accent", "│");
	if (selected) {
		// Highlight full inner row for a large click target.
		return edge + theme.bg("selectedBg", filled) + edge;
	}
	return edge + filled + edge;
}

// ── Component ────────────────────────────────────────────────────────────────

class ClickableMenuComponent implements Component {
	private items: ResolvedItem[];
	private title: string;
	private theme: Theme;
	private tui: TUI;
	private done: (item: ResolvedItem | null) => void;
	private selected = 0;
	private mouseEnabled = false;
	private closed = false;
	/** Absolute 0-based screen rows for each item (matches TUI center placement). */
	private itemScreenRows: number[] = [];
	/** Inclusive panel bounds in absolute screen coords (0-based). */
	private panel = { top: 0, bottom: 0, left: 0, right: 0 };
	private reenableTimer?: ReturnType<typeof setTimeout>;

	constructor(
		items: ResolvedItem[],
		title: string,
		theme: Theme,
		tui: TUI,
		done: (item: ResolvedItem | null) => void,
	) {
		this.items = items;
		this.title = title;
		this.theme = theme;
		this.tui = tui;
		this.done = done;
		this.enableMouse();
		this.reenableTimer = setTimeout(() => this.enableMouse(true), 50);
	}

	private enableMouse(force = false): void {
		if (this.closed) return;
		if (this.mouseEnabled && !force) return;
		try {
			this.tui.terminal.write(MOUSE_ENABLE);
			this.mouseEnabled = true;
			debugLog("mouse-enable", { force });
		} catch (err) {
			debugLog("mouse-enable-failed", String(err));
		}
	}

	private disableMouse(): void {
		if (this.reenableTimer) {
			clearTimeout(this.reenableTimer);
			this.reenableTimer = undefined;
		}
		if (!this.mouseEnabled) return;
		try {
			this.tui.terminal.write(MOUSE_DISABLE);
			debugLog("mouse-disable");
		} catch {
			// ignore
		}
		this.mouseEnabled = false;
	}

	dispose(): void {
		this.closed = true;
		this.disableMouse();
	}

	invalidate(): void {
		// Full recompute each paint (height depends on terminal.rows).
	}

	private close(item: ResolvedItem | null): void {
		if (this.closed) return;
		this.closed = true;
		this.disableMouse();
		debugLog("close", { id: item?.id ?? null });
		this.done(item);
	}

	private move(delta: number): void {
		if (this.items.length === 0) return;
		const n = this.items.length;
		this.selected = (this.selected + delta + n * 10) % n;
	}

	private activateSelected(): void {
		const item = this.items[this.selected];
		if (item) this.close(item);
	}

	handleInput(data: string): void {
		if (this.closed) return;

		const mouse = parseMouse(data);
		if (mouse) {
			this.handleMouse(mouse);
			return;
		}

		if (debugEnabled && data.startsWith("\x1b")) {
			debugLog("input-csi", {
				codes: [...data].map((c) => c.charCodeAt(0)),
				json: JSON.stringify(data),
			});
		}

		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.close(null);
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.activateSelected();
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.move(-1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.move(1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.home)) {
			this.selected = 0;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.end)) {
			this.selected = Math.max(0, this.items.length - 1);
			this.tui.requestRender();
			return;
		}

		if (data.length === 1 && data >= "1" && data <= "9") {
			const idx = Number(data) - 1;
			if (idx >= 0 && idx < this.items.length) {
				this.selected = idx;
				this.activateSelected();
			}
			return;
		}

		if (data.length === 1) {
			const ch = data.toLowerCase();
			const idx = this.items.findIndex((it) => it.hotkey?.toLowerCase() === ch);
			if (idx >= 0) {
				this.selected = idx;
				this.activateSelected();
			}
		}
	}

	/** Map screen coords to item index, or -1 if not over an item row. */
	private itemIndexAt(screenRow: number, screenCol: number): number {
		const { top, bottom, left, right } = this.panel;
		const insidePanel =
			screenRow >= top &&
			screenRow <= bottom &&
			screenCol >= left &&
			screenCol <= right;
		if (!insidePanel) return -1;

		let itemIndex = this.itemScreenRows.indexOf(screenRow);
		if (itemIndex < 0 && this.itemScreenRows.length > 0) {
			const first = this.itemScreenRows[0]!;
			const last = this.itemScreenRows[this.itemScreenRows.length - 1]!;
			if (screenRow >= first && screenRow <= last) {
				let best = 0;
				let bestDist = Math.abs(this.itemScreenRows[0]! - screenRow);
				for (let i = 1; i < this.itemScreenRows.length; i++) {
					const d = Math.abs(this.itemScreenRows[i]! - screenRow);
					if (d < bestDist) {
						best = i;
						bestDist = d;
					}
				}
				itemIndex = best;
			}
		}
		return itemIndex;
	}

	private hoverItem(itemIndex: number): void {
		if (itemIndex < 0 || itemIndex === this.selected) return;
		this.selected = itemIndex;
		this.tui.requestRender();
	}

	private handleMouse(ev: MouseEvent): void {
		debugLog("mouse", ev);

		const screenRow = ev.row - 1; // 0-based
		const screenCol = ev.col - 1;
		const itemIndex = this.itemIndexAt(screenRow, screenCol);

		// Hover / drag motion: highlight item under cursor, never activate.
		if (ev.motion) {
			this.hoverItem(itemIndex);
			return;
		}

		if (ev.wheel && !ev.release) {
			this.move(ev.wheel === "up" ? -1 : 1);
			this.tui.requestRender();
			return;
		}

		if (ev.release || ev.wheel) return;
		// Strict left press only (button 0 after stripping motion bit).
		if (ev.button !== 0) return;

		const { top, bottom, left, right } = this.panel;
		const insidePanel =
			screenRow >= top &&
			screenRow <= bottom &&
			screenCol >= left &&
			screenCol <= right;

		debugLog("hit", {
			screenRow,
			screenCol,
			panel: this.panel,
			itemScreenRows: this.itemScreenRows,
			insidePanel,
			itemIndex,
		});

		if (!insidePanel) {
			this.close(null);
			return;
		}

		if (itemIndex >= 0) {
			this.selected = itemIndex;
			this.activateSelected();
			return;
		}

		// Chrome inside panel (title/border/hint): keep open.
		this.enableMouse(true);
		this.tui.requestRender();
	}

	/**
	 * Paint only the menu panel. TUI centers this overlay; unpainted cells leave
	 * the session visible underneath (no full-screen dim backdrop).
	 */
	render(width: number): string[] {
		this.enableMouse(true);

		const theme = this.theme;
		const termRows = Math.max(3, this.tui.terminal.rows || 24);
		const termCols = Math.max(20, this.tui.terminal.columns || width);
		const panelWidth = Math.max(20, width);
		const panelInner = Math.max(1, panelWidth - 2);

		// Content rows: top border, title, blank, items, blank, hint, bottom
		const contentRows = 1 + 1 + 1 + this.items.length + 1 + 1 + 1;
		// Mirror TUI center-anchor placement for absolute mouse hit-testing.
		const overlayRow = Math.max(0, Math.floor((termRows - contentRows) / 2));
		const overlayCol = Math.max(0, Math.floor((termCols - panelWidth) / 2));

		this.panel = {
			top: overlayRow,
			bottom: overlayRow + contentRows - 1,
			left: overlayCol,
			right: overlayCol + panelWidth - 1,
		};
		this.itemScreenRows = [];

		const hBar = theme.fg("accent", "─".repeat(panelInner));
		const topBorder = theme.fg("accent", "┌") + hBar + theme.fg("accent", "┐");
		const botBorder = theme.fg("accent", "└") + hBar + theme.fg("accent", "┘");

		const lines: string[] = [];
		const push = (rowText: string): void => {
			const mid = truncateToWidth(rowText, panelWidth, "");
			const pad = Math.max(0, panelWidth - visibleWidth(mid));
			lines.push(mid + " ".repeat(pad));
		};

		push(topBorder);

		const title = theme.fg("accent", theme.bold(` ${this.title}`));
		push(boxLine(title, panelInner, theme));
		push(boxLine("", panelInner, theme));

		for (let i = 0; i < this.items.length; i++) {
			this.itemScreenRows.push(overlayRow + 3 + i);
			const item = this.items[i]!;
			const isSel = i === this.selected;
			const num = `${i + 1}.`;
			const hot =
				item.hotkey && !(item.hotkey >= "1" && item.hotkey <= "9")
					? ` [${item.hotkey}]`
					: "";
			const prefix = isSel ? "→ " : "  ";
			const desc = item.description ? ` — ${item.description}` : "";
			const raw = `${prefix}${num} ${item.label}${hot}${desc}`;
			const styled = isSel
				? theme.fg("accent", theme.bold(raw))
				: theme.fg("text", raw);
			push(boxLine(` ${styled}`, panelInner, theme, isSel));
		}

		push(boxLine("", panelInner, theme));
		const hint = theme.fg("dim", " click row · ↑↓ · 1-9 · esc ");
		push(boxLine(hint, panelInner, theme));
		push(botBorder);

		debugLog("render", {
			termRows,
			termCols,
			panelWidth,
			panel: this.panel,
			itemScreenRows: this.itemScreenRows,
			selected: this.selected,
		});

		return lines;
	}
}

// ── Actions ──────────────────────────────────────────────────────────────────

async function runAction(
	pi: ExtensionAPI,
	item: ResolvedItem,
	ctx: ExtensionContext | ExtensionCommandContext,
): Promise<void> {
	const action = item.action ?? { type: "none" as const };
	switch (action.type) {
		case "notify":
			ctx.ui.notify(action.message, action.level ?? "info");
			break;
		case "insert":
			ctx.ui.setEditorText(action.text);
			ctx.ui.notify(`Inserted: ${item.label}`, "info");
			break;
		case "submit":
			pi.sendUserMessage(action.text);
			break;
		case "none":
		default:
			ctx.ui.notify(`Selected: ${item.label}`, "info");
			break;
	}
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function clickableMenuExtension(pi: ExtensionAPI) {
	let config = loadConfig();

	async function openMenu(
		ctx: ExtensionContext | ExtensionCommandContext,
	): Promise<void> {
		const items: ResolvedItem[] = config.items.map((it) => ({
			...it,
			action: it.action ?? { type: "none" },
		}));

		if (items.length === 0) {
			ctx.ui.notify("No menu items configured.", "warning");
			return;
		}

		const title = config.title ?? "Quick Menu";
		debugLog("open-menu", { title, count: items.length, debugEnabled });

		const selected = await ctx.ui.custom<ResolvedItem | null>(
			(tui, theme, _kb, done) =>
				new ClickableMenuComponent(items, title, theme, tui, done),
			{ overlay: true, overlayOptions: OVERLAY },
		);

		if (!selected) return;
		await runAction(pi, selected, ctx);
	}

	pi.registerCommand("menu", {
		description: "Open the clickable quick menu (mouse + keyboard)",
		handler: async (args, ctx) => {
			const cmd = args?.trim().toLowerCase();
			if (cmd === "reload") {
				config = loadConfig();
				ctx.ui.notify(
					`Reloaded menu (${config.items.length} items) from ${CONFIG_PATH}`,
					"info",
				);
				return;
			}
			if (cmd === "path") {
				ctx.ui.notify(CONFIG_PATH, "info");
				return;
			}
			if (cmd === "debug") {
				debugEnabled = !debugEnabled;
				ctx.ui.notify(
					debugEnabled ? `Menu debug ON → ${DEBUG_LOG}` : "Menu debug OFF",
					"info",
				);
				debugLog("debug-toggled", { debugEnabled });
				return;
			}
			await openMenu(ctx);
		},
	});

	pi.registerShortcut(Key.ctrlShift("m"), {
		description: "Open clickable quick menu",
		handler: async (ctx) => {
			await openMenu(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		// Clear any leftover status chip from older versions of this extension.
		ctx.ui.setStatus("clickable-menu", undefined);
	});
}
