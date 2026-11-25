/**
 * Configuration loader for the reminder-hook extension.
 *
 * Source: `<agent dir>/reminder-hook.json` — non-secret config, sibling of the
 * session store (`<agent dir>/reminder-hook/sessions/<id>/reminders.json`).
 * Read per call, so an edit takes effect on the next reminder without a
 * restart. A missing or malformed file never disables a setting: it falls back
 * to the defaults below, which are the shipped behaviour.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface ReminderConfig {
	/** Hard cap applied to a reminder that does not set `timeout_minutes`. */
	defaultTimeoutMinutes: number;
}

/** Shipped default. Every reminder is capped; a predicate that never becomes
 *  true must not wait forever (reminders also persist and re-arm on restart). */
const DEFAULT_TIMEOUT_MINUTES = 120;

function configPath(): string {
	return path.join(getAgentDir(), "reminder-hook.json");
}

export function normalizeReminderConfig(c: unknown): ReminderConfig {
	const raw = (c ?? {}) as Partial<ReminderConfig>;
	const v = raw.defaultTimeoutMinutes;
	const valid = typeof v === "number" && Number.isFinite(v) && v > 0;
	return { defaultTimeoutMinutes: valid ? v : DEFAULT_TIMEOUT_MINUTES };
}

export function loadReminderConfig(): ReminderConfig {
	try {
		return normalizeReminderConfig(JSON.parse(fs.readFileSync(configPath(), "utf-8")));
	} catch {
		return normalizeReminderConfig({});
	}
}
