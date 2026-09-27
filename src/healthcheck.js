// The container's health check (the Dockerfile's HEALTHCHECK runs `node src/healthcheck.js`): it asks
// the panel's /healthz and exits 0 when the bot says it is well, 1 when it does not answer or says not.
//
// PANEL, PANEL_PORT, PANEL_HOST and PANEL_TOKEN are read through config.js, exactly as the bot reads
// them. The check used to carry its own rule for "off", which knew four words; PANEL=disabled, kapalı,
// hayır or a quoted "0" (docker --env-file keeps the quotes) turned the panel off for the bot but not
// for the check, which then asked a panel that had never started, called a working bot unhealthy, and
// had it restarted into the same verdict.

import { pathToFileURL } from 'node:url';
import { panelSettings } from './config.js';

// A wildcard bind address listens everywhere but is nowhere to connect to; loopback is where it is found.
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]']);

/**
 * Where the check asks, or null when there is nothing to ask: the panel is off, or it listens on a
 * port picked at random (PANEL_PORT=0) that nothing outside the bot can know.
 * @returns {{ url: string, headers: object } | null}
 */
export function healthTarget(env = process.env) {
	const { panelEnabled, panelPort, panelHost, panelToken } = panelSettings(env);
	if (!panelEnabled || !panelPort) return null;
	const host = WILDCARD_HOSTS.has(panelHost.toLowerCase()) ? '127.0.0.1' : panelHost;
	// An IPv6 address goes into a URL in brackets, as the panel writes it into its own Host check.
	const name = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
	return {
		url: `http://${name}:${panelPort}/healthz`,
		headers: panelToken ? { authorization: `Bearer ${panelToken}` } : {},
	};
}

/**
 * Asks the panel once.
 * @returns {Promise<0|1>} the exit code: 0 healthy or no panel to ask, 1 otherwise
 */
export async function checkHealth(env = process.env, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
	const target = healthTarget(env);
	if (!target) return 0;
	try {
		const response = await fetchImpl(target.url, { headers: target.headers, signal: AbortSignal.timeout(timeoutMs) });
		return response.ok ? 0 : 1;
	} catch {
		return 1;
	}
}

// Run as a script (the HEALTHCHECK); imported (the tests), it only exports.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exit(await checkHealth());
}
