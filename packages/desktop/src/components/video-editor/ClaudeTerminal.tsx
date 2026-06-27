import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";

interface PtyOutput {
	id: string;
	data: string;
}

/**
 * Interactive terminal bound to a real PTY (Rust `portable-pty`) running an
 * isolated `claude` session. xterm.js front end; keystrokes/resize/output flow
 * over the `pty_*` Tauri commands and the `pty://output` / `pty://exit` events.
 *
 * Only functional under the Tauri shell at runtime (the `invoke`/`listen` calls
 * resolve there); harmless no-ops elsewhere.
 */
export function ClaudeTerminal() {
	const containerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		const id = `claude-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const term = new Terminal({
			fontFamily:
				'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
			fontSize: 13,
			cursorBlink: true,
			theme: {
				background: "#0a0a0a",
				foreground: "#e4e4e7",
				cursor: "#CC785C",
			},
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(container);
		fit.fit();

		let disposed = false;
		const unlisteners: UnlistenFn[] = [];

		const onData = term.onData((data) => {
			void invoke("pty_write", { id, data });
		});

		const resizeObserver = new ResizeObserver(() => {
			if (disposed) return;
			try {
				fit.fit();
				void invoke("pty_resize", { id, cols: term.cols, rows: term.rows });
			} catch {
				// container momentarily has no size; ignore
			}
		});
		resizeObserver.observe(container);

		void (async () => {
			const unOutput = await listen<PtyOutput>("pty://output", (event) => {
				if (event.payload.id === id) term.write(event.payload.data);
			});
			const unExit = await listen<PtyOutput>("pty://exit", (event) => {
				if (event.payload.id === id) {
					term.write("\r\n\x1b[2m[process exited]\x1b[0m\r\n");
				}
			});
			if (disposed) {
				unOutput();
				unExit();
				return;
			}
			unlisteners.push(unOutput, unExit);

			await invoke("pty_open", {
				id,
				cwd: "",
				command: [],
				cols: term.cols,
				rows: term.rows,
			});
			// Auto-launch an interactive Claude session in the sandbox dir.
			await invoke("pty_write", { id, data: "claude\r" });
		})();

		return () => {
			disposed = true;
			resizeObserver.disconnect();
			onData.dispose();
			for (const un of unlisteners) un();
			void invoke("pty_kill", { id });
			term.dispose();
		};
	}, []);

	return <div ref={containerRef} className="w-full h-full min-h-0 bg-card" />;
}
