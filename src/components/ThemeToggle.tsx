import { Monitor, Moon, Sun } from "lucide-react";
import { type Theme, useTheme } from "@/contexts/ThemeContext";

const ORDER: Theme[] = ["system", "light", "dark"];
const ICON: Record<Theme, typeof Sun> = { light: Sun, dark: Moon, system: Monitor };
const LABEL: Record<Theme, string> = { light: "Light", dark: "Dark", system: "System" };

/** Cycles theme system → light → dark. Topbar control for theme management. */
export function ThemeToggle() {
	const { theme, setTheme } = useTheme();
	const Icon = ICON[theme];
	const next = () => setTheme(ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length] as Theme);
	return (
		<button
			type="button"
			onClick={next}
			title={`Theme: ${LABEL[theme]} (click to switch)`}
			aria-label={`Theme: ${LABEL[theme]}`}
			className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-white/50 hover:text-white/90 hover:bg-white/[0.08] transition-all duration-150 text-[11px] font-medium"
		>
			<Icon size={14} />
		</button>
	);
}
