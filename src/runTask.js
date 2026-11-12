/**
 * Builds and runs one task: the wiring that turns an envelope plus this
 * machine's configuration into a way of working the portal.
 *
 * A task is worked deterministically when it can be - a known service whose
 * recipe is configured (see src/flows) - and by the model-driven Agent only
 * otherwise, or as a fallback when a deterministic run gets stuck. That ordering
 * is the point: the model is the exception, not the default, so most runs need no
 * external AI at all.
 *
 * It is the one place that knows how the pieces fit together, so both entry
 * points share it: the HTTP job store (src/server) injects its step and artifact
 * sinks and a cancellation signal, and the command-line runner (bin/run-task.js)
 * passes its own.
 */

import { Agent } from './Agent.js';
import { parseEnvelope } from './envelope.js';
import { CredentialStore } from './credentials.js';
import { driverFactory } from './drivers/index.js';
import { twoFactorChannel } from './twofactor/index.js';
import { extractorFor } from './extractors/index.js';
import { recipeFor } from './flows/index.js';
import { FlowRunner } from './flows/FlowRunner.js';
import { SURFACE_BROWSER, SURFACE_DESKTOP } from './config.js';

/**
 * Builds the surface the configuration asks for. The import is dynamic so that
 * the browser surface - the only file that loads Puppeteer - is never pulled in
 * on a desktop-only machine, which is what keeps that deployment dependency-free.
 *
 * @param {object} envelope
 * @param {object} config
 * @param {CredentialStore} credentials
 * @returns {Promise<object>}
 */
async function buildSurface(envelope, config, credentials) {
	const alias = envelope.service.credentialAlias;

	if (config.surface === SURFACE_DESKTOP) {
		const { DesktopSurface } = await import('./surface/DesktopSurface.js');
		const { create } = await import('./surface/desktopHost.js');

		/**
		 * A task that harvests something off the wire gets a real Chrome with a
		 * network tap (started as a plain process, never through Puppeteer), in a
		 * profile of its own per credential alias so the sign-in persists.
		 */
		let tap = null;

		if (extractorFor(envelope.capture ?? envelope.service.key)) {
			const { ChromeTap } = await import('./surface/ChromeTap.js');

			tap = new ChromeTap({
				profileDir: `${config.profileDir}/desktop-${alias ?? envelope.service.key}`,
				port: config.desktopChromePort,
				chromePath: config.chromePath,
				startUrl: envelope.startUrl ?? envelope.service.url,
			});
		}

		return new DesktopSurface({
			tap,
			desktop: create(config.workDir ? `${config.workDir}/screens` : undefined, {
				powershell: config.powershell,
				screenshotWidth: config.screenshotWidth,
				maxShrink: config.maxShrink,
				maxScreenshotWidth: config.maxScreenshotWidth,
				minScreenshotWidth: config.minScreenshotWidth,
			}),
			failsafe: config.desktopFailsafe,
		});
	}

	const { BrowserSurface } = await import('./surface/BrowserSurface.js');

	return new BrowserSurface({
		/**
		 * The allowlist is the service origin plus whatever the credential's own
		 * entry permits - a delegated sign-in (Growth hands its to UAE Pass) lives
		 * on another host, taken from this machine's store and never from the task,
		 * so a task cannot name a host to be typed into.
		 */
		allowedOrigins: [...envelope.allowedOrigins, ...(alias ? credentials.loginOrigins(alias) : [])],
		profileRoot: config.profileDir,
		profileKey: alias ?? envelope.service.key,
		chromeChannel: config.chromeChannel,
		chromePath: config.chromePath,
		connectUrl: config.chromeConnectUrl,
	});
}

/**
 * Assembles an Agent for a parsed envelope.
 *
 * @param {object} envelope A parsed envelope (see parseEnvelope).
 * @param {object} deps
 * @param {object} deps.config
 * @param {CredentialStore} deps.credentials
 * @param {AbortSignal} deps.signal
 * @param {(name: string, detail?: object|null) => void} [deps.recordStep]
 * @param {(artifact: object) => object} [deps.putArtifact]
 * @returns {Promise<Agent>}
 */
export async function buildAgent(envelope, { config, credentials, signal, recordStep, putArtifact }) {
	const surfaceKind = config.surface;
	const surface = await buildSurface(envelope, config, credentials);

	return new Agent(envelope, {
		surface,
		makeDriver: driverFactory(config),
		credentials,
		twoFactor: twoFactorChannel(envelope, config),
		surfaceKind,
		config,
		signal,
		recordStep,
		putArtifact,
	});
}

/**
 * The runner the job store injects: it parses the stored envelope, builds the
 * agent, and maps the agent's answer to the `{ok, outcome, error, result}` shape
 * the store records.
 *
 * @param {object} task
 * @param {object} task.envelope The raw envelope as dispatched.
 * @param {AbortSignal} task.signal
 * @param {object} task.config
 * @param {function} task.recordStep
 * @param {function} task.putArtifact
 * @returns {Promise<{ok: boolean, outcome?: string, error?: string, result?: object}>}
 */
export async function runTask({ envelope, signal, config, recordStep, putArtifact }) {
	let parsed;

	try {
		parsed = parseEnvelope(envelope);
	} catch (error) {
		return { ok: false, outcome: 'bad_envelope', error: error.message };
	}

	const credentials = new CredentialStore({ file: config.credentialsFile, env: config.env });
	const deps = { config, credentials, signal, recordStep, putArtifact };

	/**
	 * Work it deterministically when we can: the configured mode asks for it, the
	 * browser surface is in use (recipes drive the DOM), and this service has a
	 * recipe whose selectors are configured.
	 */
	const recipe = recipeFor(parsed.service.key);
	const deterministic = config.mode === 'deterministic'
		&& config.surface === SURFACE_BROWSER
		&& recipe
		&& recipe.ready(config);

	if (deterministic) {
		const surface = await buildSurface(parsed, config, credentials);

		const runner = new FlowRunner({
			envelope: parsed,
			surface,
			credentials,
			twoFactor: twoFactorChannel(parsed, config),
			extractor: extractorFor(parsed.service.key),
			config,
			signal,
			recordStep,
			putArtifact,
		});

		const { fallback, ...result } = await runner.run(recipe.build(parsed, config));

		if (result.ok || !(fallback && config.deterministicFallback)) {
			return result;
		}

		recordStep?.('the deterministic flow could not finish; handing off to the model');
	}

	// The model-driven path: chosen explicitly, or as a fallback, or for a service
	// with no ready recipe.
	const agent = await buildAgent(parsed, deps);

	return agent.run();
}
