import { dlopen, FFIType, ptr } from "bun:ffi";
import * as fs from "node:fs";
import { $env, logger } from "@oh-my-pi/pi-utils";
import { setKittyProtocolActive } from "./keys";
import { StdinBuffer } from "./stdin-buffer";

/**
 * Minimal terminal interface for TUI
 */

// Track active terminal for emergency cleanup on crash
let activeTerminal: ProcessTerminal | null = null;
// Track if a terminal was ever started (for emergency restore logic)
let terminalEverStarted = false;

const STD_INPUT_HANDLE = -10;
const ENABLE_VIRTUAL_TERMINAL_INPUT = 0x0200;
/**
 * Emergency terminal restore - call this from signal/crash handlers
 * Resets terminal state without requiring access to the ProcessTerminal instance
 */
export function emergencyTerminalRestore(): void {
	try {
		const terminal = activeTerminal;
		if (terminal) {
			terminal.stop();
			terminal.showCursor();
		} else if (terminalEverStarted) {
			// Blind restore only if we know a terminal was started but lost track of it
			// This avoids writing escape sequences for non-TUI commands (grep, commit, etc.)
			process.stdout.write(
				"\x1b[?2004l" + // Disable bracketed paste
					"\x1b[?2031l" + // Disable Mode 2031 appearance notifications
					"\x1b[<u" + // Pop kitty keyboard protocol
					"\x1b[?25h", // Show cursor
			);
			if (process.stdin.setRawMode) {
				process.stdin.setRawMode(false);
			}
		}
	} catch {
		// Terminal may already be dead during crash cleanup - ignore errors
	}
}
/** Terminal-reported appearance (dark/light mode). */
export type TerminalAppearance = "dark" | "light";
export interface Terminal {
	// Start the terminal with input and resize handlers
	start(onInput: (data: string) => void, onResize: () => void): void;

	// Stop the terminal and restore state
	stop(): void;

	/**
	 * Drain stdin before exiting to prevent Kitty key release events from
	 * leaking to the parent shell over slow SSH connections.
	 * @param maxMs - Maximum time to drain (default: 1000ms)
	 * @param idleMs - Exit early if no input arrives within this time (default: 50ms)
	 */
	drainInput(maxMs?: number, idleMs?: number): Promise<void>;

	// Write output to terminal
	write(data: string): void;

	// Get terminal dimensions
	get columns(): number;
	get rows(): number;

	// Whether Kitty keyboard protocol is active
	get kittyProtocolActive(): boolean;

	// Cursor positioning (relative to current position)
	moveBy(lines: number): void; // Move cursor up (negative) or down (positive) by N lines

	// Cursor visibility
	hideCursor(): void; // Hide the cursor
	showCursor(): void; // Show the cursor

	// Clear operations
	clearLine(): void; // Clear current line
	clearFromCursor(): void; // Clear from cursor to end of screen
	clearScreen(): void; // Clear entire screen and move cursor to (0,0)

	// Title operations
	setTitle(title: string): void; // Set terminal window title

	/**
	 * Register a callback for terminal appearance (dark/light) changes.
	 * Detection uses OSC 11 background color query with Mode 2031 as a change trigger.
	 * Fires when the detected appearance changes; also fires for the initial detection.
	 */
	onAppearanceChange(callback: (appearance: TerminalAppearance) => void): void;

	/** The last detected terminal appearance, or undefined if not yet known. */
	get appearance(): TerminalAppearance | undefined;
}

/**
 * Real terminal using process.stdin/stdout
 */
export class ProcessTerminal implements Terminal {
	#wasRaw = false;
	#inputHandler?: (data: string) => void;
	#resizeHandler?: () => void;
	#kittyProtocolActive = false;
	#stdinBuffer?: StdinBuffer;
	#stdinDataHandler?: (data: string) => void;
	#dead = false;
	#writeLogPath = $env.PI_TUI_WRITE_LOG || "";
	#windowsVTInputRestore?: () => void;
	#appearanceCallbacks: Array<(appearance: TerminalAppearance) => void> = [];
	#appearance: TerminalAppearance | undefined;
	#osc11Pending = false;

	get kittyProtocolActive(): boolean {
		return this.#kittyProtocolActive;
	}

	get appearance(): TerminalAppearance | undefined {
		return this.#appearance;
	}

	onAppearanceChange(callback: (appearance: TerminalAppearance) => void): void {
		this.#appearanceCallbacks.push(callback);
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.#inputHandler = onInput;
		this.#resizeHandler = onResize;

		// Register for emergency cleanup
		activeTerminal = this;
		terminalEverStarted = true;

		// Save previous state and enable raw mode
		this.#wasRaw = process.stdin.isRaw || false;
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(true);
		}
		process.stdin.setEncoding("utf8");
		process.stdin.resume();

		// Enable bracketed paste mode - terminal will wrap pastes in \x1b[200~ ... \x1b[201~
		this.#safeWrite("\x1b[?2004h");

		// Set up resize handler immediately
		process.stdout.on("resize", this.#resizeHandler);

		// Refresh terminal dimensions - they may be stale after suspend/resume
		// (SIGWINCH is lost while process is stopped). Unix only.
		if (process.platform !== "win32") {
			process.kill(process.pid, "SIGWINCH");
		}

		// On Windows, enable ENABLE_VIRTUAL_TERMINAL_INPUT so the console sends
		// VT escape sequences (e.g. \x1b[Z for Shift+Tab) instead of raw console
		// events that lose modifier information. Must run after setRawMode(true)
		// since that resets console mode flags.
		this.#enableWindowsVTInput();
		// Query and enable Kitty keyboard protocol
		// The query handler intercepts input temporarily, then installs the user's handler
		// See: https://sw.kovidgoyal.net/kitty/keyboard-protocol/
		this.#queryAndEnableKittyProtocol();

		// Query terminal background color via OSC 11 for dark/light detection.
		// Uses DA1 (Primary Device Attributes) as a sentinel: terminals process
		// sequences in order, so if DA1 response arrives before OSC 11 response,
		// the terminal does not support OSC 11. This avoids indefinite hangs.
		// Technique used by Neovim, bat, fish, and charmbracelet/lipgloss.
		this.#queryBackgroundColor();

		// Subscribe to Mode 2031 appearance change notifications.
		// When the terminal reports a change, we re-query OSC 11 to get the
		// actual background color rather than trusting the binary dark/light
		// value from Mode 2031 directly (following Neovim/fish convention).
		this.#safeWrite("\x1b[?2031h");
	}

	/**
	 * On Windows, add ENABLE_VIRTUAL_TERMINAL_INPUT to the stdin console mode
	 * so modified keys (for example Shift+Tab) arrive as VT escape sequences.
	 */
	#enableWindowsVTInput(): void {
		if (process.platform !== "win32") return;
		this.#restoreWindowsVTInput();
		try {
			const kernel32 = dlopen("kernel32.dll", {
				GetStdHandle: { args: [FFIType.i32], returns: FFIType.ptr },
				GetConsoleMode: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
				SetConsoleMode: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.bool },
			});
			const handle = kernel32.symbols.GetStdHandle(STD_INPUT_HANDLE);
			const mode = new Uint32Array(1);
			const modePtr = ptr(mode);
			if (!modePtr || !kernel32.symbols.GetConsoleMode(handle, modePtr)) {
				kernel32.close();
				return;
			}
			const originalMode = mode[0]!;
			const vtMode = originalMode | ENABLE_VIRTUAL_TERMINAL_INPUT;
			if (vtMode !== originalMode && !kernel32.symbols.SetConsoleMode(handle, vtMode)) {
				kernel32.close();
				return;
			}
			this.#windowsVTInputRestore = () => {
				try {
					kernel32.symbols.SetConsoleMode(handle, originalMode);
				} finally {
					kernel32.close();
				}
			};
		} catch {
			// bun:ffi unavailable or console API unsupported; keep startup non-fatal.
		}
	}

	#restoreWindowsVTInput(): void {
		if (process.platform !== "win32") return;
		const restore = this.#windowsVTInputRestore;
		this.#windowsVTInputRestore = undefined;
		if (!restore) return;
		try {
			restore();
		} catch {
			// Ignore restore errors during terminal teardown.
		}
	}

	/**
	 * Set up StdinBuffer to split batched input into individual sequences.
	 * This ensures components receive single events, making matchesKey/isKeyRelease work correctly.
	 *
	 * Also watches for Kitty protocol response and enables it when detected.
	 * This is done here (after stdinBuffer parsing) rather than on raw stdin
	 * to handle the case where the response arrives split across multiple events.
	 */
	#setupStdinBuffer(): void {
		this.#stdinBuffer = new StdinBuffer({ timeout: 10 });

		// Kitty protocol response pattern: \x1b[?<flags>u
		const kittyResponsePattern = /^\x1b\[\?(\d+)u$/;

		// Mode 2031 DSR response pattern: \x1b[?997;{1=dark,2=light}n
		const appearanceDsrPattern = /^\x1b\[\?997;([12])n$/;

		// OSC 11 response: \x1b]11;rgb:RRRR/GGGG/BBBB(ST or BEL)
		// Also handles rgba: format from some terminals
		const osc11ResponsePattern = /^\x1b\]11;rgba?:([0-9a-fA-F]+)\/([0-9a-fA-F]+)\/([0-9a-fA-F]+)/;

		// DA1 (Primary Device Attributes) response: \x1b[?...c
		const da1ResponsePattern = /^\x1b\[\?[\d;]*c$/;

		// Forward individual sequences to the input handler
		this.#stdinBuffer.on("data", (sequence: string) => {
			// Check for Kitty protocol response (only if not already enabled)
			if (!this.#kittyProtocolActive) {
				const match = sequence.match(kittyResponsePattern);
				if (match) {
					this.#kittyProtocolActive = true;
					setKittyProtocolActive(true);

					// Enable Kitty keyboard protocol (push flags)
					// Flag 1 = disambiguate escape codes
					// Flag 2 = report event types (press/repeat/release)
					// Flag 4 = report alternate keys
					this.#safeWrite("\x1b[>7u");
					return; // Don't forward protocol response to TUI
				}
			}

			// OSC 11 response: parse RGB and compute luminance for dark/light
			const osc11Match = sequence.match(osc11ResponsePattern);
			if (osc11Match) {
				this.#osc11Pending = false;
				this.#handleOsc11Response(osc11Match[1]!, osc11Match[2]!, osc11Match[3]!);
				return;
			}

			// DA1 response: if OSC 11 is still pending, the terminal doesn't support it
			if (this.#osc11Pending && da1ResponsePattern.test(sequence)) {
				this.#osc11Pending = false;
				return;
			}

			// Mode 2031 appearance change notification: re-query OSC 11 for the
			// actual background color instead of using the binary dark/light value.
			const appearanceMatch = sequence.match(appearanceDsrPattern);
			if (appearanceMatch) {
				this.#queryBackgroundColor();
				return;
			}

			if (this.#inputHandler) {
				this.#inputHandler(sequence);
			}
		});

		// Re-wrap paste content with bracketed paste markers for existing editor handling
		this.#stdinBuffer.on("paste", (content: string) => {
			if (this.#inputHandler) {
				this.#inputHandler(`\x1b[200~${content}\x1b[201~`);
			}
		});

		// Handler that pipes stdin data through the buffer
		this.#stdinDataHandler = (data: string) => {
			this.#stdinBuffer!.process(data);
		};
	}

	/**
	 * Send OSC 11 background color query followed by DA1 sentinel.
	 * The DA1 sentinel avoids indefinite hangs: if the DA1 response arrives
	 * before the OSC 11 response, the terminal does not support OSC 11.
	 */
	#queryBackgroundColor(): void {
		this.#osc11Pending = true;
		this.#safeWrite("\x1b]11;?\x07"); // OSC 11 query (BEL terminated)
		this.#safeWrite("\x1b[c"); // DA1 sentinel
	}

	/**
	 * Parse an OSC 11 background color response and compute luminance.
	 * Handles both 4-digit (e.g. rgb:1a1a/2b2b/3c3c) and 2-digit (e.g. rgb:1a/2b/3c) forms.
	 * Uses BT.601 luminance (same formula as Neovim and fish shell).
	 */
	#handleOsc11Response(rHex: string, gHex: string, bHex: string): void {
		// Normalize to 0-1 range. Terminals may respond with 2 or 4 hex digits per channel.
		const normalize = (hex: string): number => {
			const value = parseInt(hex, 16);
			if (Number.isNaN(value)) return 0;
			// 2-digit: max 0xFF, 4-digit: max 0xFFFF
			return hex.length <= 2 ? value / 0xff : value / 0xffff;
		};
		const r = normalize(rHex);
		const g = normalize(gHex);
		const b = normalize(bHex);
		// BT.601 perceived luminance
		const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
		const mode: TerminalAppearance = luminance < 0.5 ? "dark" : "light";
		const changed = mode !== this.#appearance;
		this.#appearance = mode;
		if (changed) {
			for (const cb of this.#appearanceCallbacks) {
				try {
					cb(mode);
				} catch {
					/* ignore callback errors */
				}
			}
		}
	}

	/**
	 * Query terminal for Kitty keyboard protocol support and enable if available.
	 *
	 * Sends CSI ? u to query current flags. If terminal responds with CSI ? <flags> u,
	 * it supports the protocol and we enable it with CSI > 1 u.
	 *
	 * The response is detected in setupStdinBuffer's data handler, which properly
	 * handles the case where the response arrives split across multiple stdin events.
	 */
	#queryAndEnableKittyProtocol(): void {
		this.#setupStdinBuffer();
		process.stdin.on("data", this.#stdinDataHandler!);
		this.#safeWrite("\x1b[?u");
	}

	async drainInput(maxMs = 1000, idleMs = 50): Promise<void> {
		if (this.#kittyProtocolActive) {
			// Disable Kitty keyboard protocol first so any late key releases
			// do not generate new Kitty escape sequences.
			this.#safeWrite("\x1b[<u");
			this.#kittyProtocolActive = false;
			setKittyProtocolActive(false);
		}

		const previousHandler = this.#inputHandler;
		this.#inputHandler = undefined;

		let lastDataTime = Date.now();
		const onData = () => {
			lastDataTime = Date.now();
		};

		process.stdin.on("data", onData);
		const endTime = Date.now() + maxMs;

		try {
			while (true) {
				const now = Date.now();
				const timeLeft = endTime - now;
				if (timeLeft <= 0) break;
				if (now - lastDataTime >= idleMs) break;
				await new Promise(resolve => setTimeout(resolve, Math.min(idleMs, timeLeft)));
			}
		} finally {
			process.stdin.removeListener("data", onData);
			this.#inputHandler = previousHandler;
		}
	}

	stop(): void {
		// Unregister from emergency cleanup
		if (activeTerminal === this) {
			activeTerminal = null;
		}

		// Disable bracketed paste mode
		this.#safeWrite("\x1b[?2004l");

		// Disable Mode 2031 appearance change notifications
		this.#safeWrite("\x1b[?2031l");
		this.#appearanceCallbacks = [];
		this.#osc11Pending = false;

		// Disable Kitty keyboard protocol if not already done by drainInput()
		if (this.#kittyProtocolActive) {
			this.#safeWrite("\x1b[<u");
			this.#kittyProtocolActive = false;
			setKittyProtocolActive(false);
		}

		this.#restoreWindowsVTInput();
		// Clean up StdinBuffer
		if (this.#stdinBuffer) {
			this.#stdinBuffer.destroy();
			this.#stdinBuffer = undefined;
		}

		// Remove event handlers
		if (this.#stdinDataHandler) {
			process.stdin.removeListener("data", this.#stdinDataHandler);
			this.#stdinDataHandler = undefined;
		}
		this.#inputHandler = undefined;
		this.#appearance = undefined;
		if (this.#resizeHandler) {
			process.stdout.removeListener("resize", this.#resizeHandler);
			this.#resizeHandler = undefined;
		}

		// Pause stdin to prevent any buffered input (e.g., Ctrl+D) from being
		// re-interpreted after raw mode is disabled. This fixes a race condition
		// where Ctrl+D could close the parent shell over SSH.
		process.stdin.pause();

		// Restore raw mode state
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(this.#wasRaw);
		}
	}

	write(data: string): void {
		this.#safeWrite(data);
		if (this.#writeLogPath) {
			try {
				fs.appendFileSync(this.#writeLogPath, data, { encoding: "utf8" });
			} catch {
				// Ignore logging errors
			}
		}
	}

	#safeWrite(data: string): void {
		if (this.#dead) return;
		try {
			process.stdout.write(data);
		} catch (err) {
			// Any write failure means terminal is dead - no recovery possible
			this.#dead = true;
			logger.warn("terminal is dead - no recovery possible", { error: err, data });
		}
	}

	get columns(): number {
		return process.stdout.columns || 80;
	}

	get rows(): number {
		return process.stdout.rows || 24;
	}

	moveBy(lines: number): void {
		if (lines > 0) {
			// Move down
			this.#safeWrite(`\x1b[${lines}B`);
		} else if (lines < 0) {
			// Move up
			this.#safeWrite(`\x1b[${-lines}A`);
		}
		// lines === 0: no movement
	}

	hideCursor(): void {
		this.#safeWrite("\x1b[?25l");
	}

	showCursor(): void {
		this.#safeWrite("\x1b[?25h");
	}

	clearLine(): void {
		this.#safeWrite("\x1b[K");
	}

	clearFromCursor(): void {
		this.#safeWrite("\x1b[J");
	}

	clearScreen(): void {
		this.#safeWrite("\x1b[H\x1b[0J"); // Move to home (1,1) and clear from cursor to end
	}

	setTitle(title: string): void {
		// OSC 0;title BEL - set terminal window title
		this.#safeWrite(`\x1b]0;${title}\x07`);
	}
}
