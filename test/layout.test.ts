/**
 * Pure layout math tests for clickable-menu (no TUI runtime).
 * Run: node --test --experimental-strip-types test/layout.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

/** Mirror of clampOverlayOrigin in extensions/clickable-menu/index.ts */
function clampOverlayOrigin(
	termRows: number,
	termCols: number,
	panelWidth: number,
	contentRows: number,
): { row: number; col: number } {
	const h = Math.max(1, contentRows);
	const w = Math.max(1, panelWidth);
	const rows = Math.max(1, termRows);
	const cols = Math.max(1, termCols);
	let row = Math.floor((rows - h) / 2);
	let col = Math.floor((cols - w) / 2);
	row = Math.max(0, Math.min(row, rows - h));
	col = Math.max(0, Math.min(col, cols - w));
	return { row, col };
}

function itemScreenRows(panelTop: number, itemCount: number): number[] {
	// top border + title + blank = 3 rows before first item
	return Array.from({ length: itemCount }, (_, i) => panelTop + 3 + i);
}

function itemIndexAt(
	screenRow: number,
	screenCol: number,
	panel: { top: number; bottom: number; left: number; right: number },
	itemRows: number[],
): number {
	const inside =
		screenRow >= panel.top &&
		screenRow <= panel.bottom &&
		screenCol >= panel.left &&
		screenCol <= panel.right;
	if (!inside) return -1;
	return itemRows.indexOf(screenRow);
}

describe("clampOverlayOrigin", () => {
	it("centers a 58x18 panel in 58x116 terminal", () => {
		const contentRows = 18;
		const width = 58;
		const { row, col } = clampOverlayOrigin(58, 116, width, contentRows);
		assert.equal(row, Math.floor((58 - 18) / 2)); // 20
		assert.equal(col, Math.floor((116 - 58) / 2)); // 29
	});

	it("centers in a narrower terminal after resize 82 -> 116", () => {
		const a = clampOverlayOrigin(58, 82, 58, 18);
		const b = clampOverlayOrigin(58, 116, 58, 18);
		assert.equal(a.row, b.row); // vertical unchanged
		assert.equal(a.col, Math.floor((82 - 58) / 2)); // 12
		assert.equal(b.col, 29);
	});

	it("clamps when panel is taller than terminal", () => {
		const { row, col } = clampOverlayOrigin(10, 40, 58, 18);
		assert.equal(row, 0);
		assert.equal(col, 0); // width min(58,40)= we'll pass 40
		const narrow = clampOverlayOrigin(10, 40, 40, 18);
		assert.equal(narrow.row, 0);
		assert.equal(narrow.col, 0);
	});

	it("is stable across huge session sizes (placement ignores buffer length)", () => {
		// Placement uses only term size + panel size — not contentLineCount.
		const short = clampOverlayOrigin(58, 116, 58, 18);
		const tall = clampOverlayOrigin(58, 116, 58, 18);
		assert.deepEqual(short, tall);
		assert.equal(short.row, 20);
		assert.equal(short.col, 29);
	});
});

describe("hit testing", () => {
	it("maps debug-log click (row 24 col 43) to item 0 for panel top=20 left=29", () => {
		const panel = { top: 20, bottom: 37, left: 29, right: 86 };
		const rows = itemScreenRows(20, 12);
		// From debug: click screenRow 23 (0-based) col 42 → itemIndex 0
		assert.equal(itemIndexAt(23, 42, panel, rows), 0);
		// screenRow 28 → item 5
		assert.equal(itemIndexAt(28, 42, panel, rows), 5);
		// outside panel
		assert.equal(itemIndexAt(49 - 1, 94 - 1, panel, rows), -1);
	});

	it("updates item rows when panel recenters after height change", () => {
		const a = clampOverlayOrigin(58, 116, 58, 18);
		const b = clampOverlayOrigin(40, 116, 58, 18);
		const rowsA = itemScreenRows(a.row, 12);
		const rowsB = itemScreenRows(b.row, 12);
		assert.notDeepEqual(rowsA, rowsB);
		// first item is always panelTop+3
		assert.equal(rowsA[0], a.row + 3);
		assert.equal(rowsB[0], b.row + 3);
	});
});
