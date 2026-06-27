import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.tsx";
import { I18nProvider } from "./contexts/I18nContext";
import { ThemeProvider } from "./contexts/ThemeContext";
import { installElectronApiShim } from "./lib/tauri/electronApiShim";
import "./index.css";

// Under Tauri, install the Electron-compat shim before anything reads
// window.electronAPI. No-op under Electron (real preload bridge is used).
installElectronApiShim();

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
