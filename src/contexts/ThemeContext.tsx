import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";

export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "foxscreen.theme";

interface ThemeContextValue {
	/** User preference: light / dark / system. */
	theme: Theme;
	/** Effective theme after resolving "system". */
	resolvedTheme: ResolvedTheme;
	setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function systemTheme(): ResolvedTheme {
	return typeof window !== "undefined" &&
		window.matchMedia?.("(prefers-color-scheme: dark)").matches
		? "dark"
		: "light";
}

function readStored(): Theme {
	if (typeof localStorage === "undefined") return "dark";
	const v = localStorage.getItem(STORAGE_KEY);
	return v === "light" || v === "dark" || v === "system" ? v : "dark";
}

/** Toggle the `.dark` class shadcn/Tailwind (`darkMode: ["class"]`) keys off. */
function applyResolved(resolved: ResolvedTheme): void {
	document.documentElement.classList.toggle("dark", resolved === "dark");
}

export function ThemeProvider({ children }: { children: ReactNode }) {
	const [theme, setThemeState] = useState<Theme>(readStored);
	const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
		theme === "system" ? systemTheme() : theme,
	);

	useEffect(() => {
		const resolved = theme === "system" ? systemTheme() : theme;
		setResolvedTheme(resolved);
		applyResolved(resolved);
		if (theme !== "system") return;
		const mq = window.matchMedia("(prefers-color-scheme: dark)");
		const onChange = () => {
			const r = systemTheme();
			setResolvedTheme(r);
			applyResolved(r);
		};
		mq.addEventListener("change", onChange);
		return () => mq.removeEventListener("change", onChange);
	}, [theme]);

	const value = useMemo<ThemeContextValue>(
		() => ({
			theme,
			resolvedTheme,
			setTheme: (t) => {
				setThemeState(t);
				try {
					localStorage.setItem(STORAGE_KEY, t);
				} catch {
					// ignore storage failures (private mode, etc.)
				}
			},
		}),
		[theme, resolvedTheme],
	);

	return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
	const ctx = useContext(ThemeContext);
	if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
	return ctx;
}
