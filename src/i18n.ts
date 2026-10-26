export type Language = "en" | "zh";

/** The environment variable that explicitly selects the UI language. */
export const LANGUAGE_ENV = "OMOMP_LANG";

export type ConfigLanguageReader = () => unknown;

const UNREAD = Symbol("unread");
let configLanguageReader: ConfigLanguageReader | undefined;
let cachedConfigLanguage: Language | undefined | typeof UNREAD = UNREAD;

/**
 * Installs the OMP-side reader for the agent-dir `omomp` file. The reader is invoked lazily,
 * at most once, only after an explicit environment value has been ruled out.
 */
export function setupI18n(reader: ConfigLanguageReader): void {
	if (configLanguageReader === undefined) configLanguageReader = reader;
}

/** Resolves a language value from an explicit environment/config setting. */
function parseLanguage(value: unknown): Language | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	return normalized === "en" || normalized === "zh" ? normalized : undefined;
}

/**
 * Resolves the current process language. The explicit environment value is checked on each call;
 * only the agent-dir config value is cached because it applies from the next process start.
 */
export function language(): Language {
	const explicit = parseLanguage(process.env[LANGUAGE_ENV]);
	if (explicit !== undefined) return explicit;

	if (cachedConfigLanguage === UNREAD) {
		try {
			cachedConfigLanguage = parseLanguage(configLanguageReader?.());
		} catch {
			cachedConfigLanguage = undefined;
		}
	}
	if (cachedConfigLanguage !== undefined) return cachedConfigLanguage;

	for (const key of ["LC_ALL", "LC_MESSAGES", "LANG"] as const) {
		const locale = process.env[key]?.trim();
		if (locale) return locale.toLowerCase().startsWith("zh") ? "zh" : "en";
	}
	return "en";
}

/** The person-facing text for this process's current language; English is written first. */
export function tr(en: string, zh: string): string {
	return language() === "zh" ? zh : en;
}
