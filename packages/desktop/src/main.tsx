import React from "react";
import ReactDOM from "react-dom/client";
// Self-hosted fonts (offline — this is a packaged desktop app, NO Google Fonts
// CDN at runtime). Plus Jakarta Sans = UI; IBM Plex Mono = numbers / timecode.
import "@fontsource/plus-jakarta-sans/400.css";
import "@fontsource/plus-jakarta-sans/500.css";
import "@fontsource/plus-jakarta-sans/600.css";
import "@fontsource/plus-jakarta-sans/700.css";
import "@fontsource/plus-jakarta-sans/800.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import App from "./App.tsx";
import { I18nProvider } from "./contexts/I18nContext";
import { ThemeProvider } from "./contexts/ThemeContext";
import { installBrowserDevMock } from "./lib/tauri/browserDevMock";
import { installElectronApiShim } from "./lib/tauri/electronApiShim";
import "./index.css";

// Under Tauri, install the Electron-compat shim before anything reads
// window.electronAPI. No-op under Electron (real preload bridge is used).
installElectronApiShim();
// In a plain browser (dev:web for visual QA), install a safe inert native-bridge
// mock so the editor shell can mount for screenshots. No-op under Tauri/prod.
installBrowserDevMock();

// Dev-only: surface the real message+stack of any uncaught render error to the
// console so headless QA (/browse) can read it. React's own log only prints the
// component stack, not the thrown error. No-op in prod.
if (import.meta.env.DEV) {
	window.addEventListener("error", (e) => {
		// eslint-disable-next-line no-console
		console.log(`__DEVERR__::${e.message}::${(e.error as Error | undefined)?.stack ?? ""}`);
	});
}

const windowType = new URLSearchParams(window.location.search).get("windowType") || "";
if (
	windowType === "hud-overlay" ||
	windowType === "source-selector" ||
	windowType === "countdown-overlay"
) {
	document.body.style.background = "transparent";
	document.documentElement.style.background = "transparent";
	document.getElementById("root")?.style.setProperty("background", "transparent");
}

ReactDOM.createRoot(document.getElementById("root")!).render(
	<React.StrictMode>
		<ThemeProvider>
			<I18nProvider>
				<App />
			</I18nProvider>
		</ThemeProvider>
	</React.StrictMode>,
);
