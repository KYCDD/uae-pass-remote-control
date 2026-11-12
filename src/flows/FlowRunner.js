/**
 * The deterministic flow runner: it works a known portal from a scripted recipe,
 * with no model in the loop.
 *
 * The model-driven Agent exists for an unknown screen, where deciding the next
 * action needs judgement. A portal we already understand - Growth, above all -
 * needs no judgement: the steps are fixed, and the only things that vary (a
 * licence number to type, whether a session is already open) are read from the
 * page and the envelope, not guessed from a screenshot. Driving it by DOM
 * selectors is both cheaper and far more reliable than asking a model to look at
 * pixels, and it keeps a live session cookie and an identity token out of a third
 * party's request logs entirely.
 *
 * A recipe is data: an array of steps (see the step vocabulary below), usually
 * built per task from the envelope. The runner executes them against the browser
 * surface's deterministic primitives, calls the same network-log extractor and
 * phone-approval channel the Agent uses, and returns the same
 * {ok, outcome, result, error} shape - so a caller cannot tell whether a task was
 * done deterministically or by the model, and can fall back from one to the other.
 *
 * It deliberately does only what a script can do with certainty. The moment a
 * step cannot proceed - a selector that never appears, an unexpected page - it
 * stops with `fallback: true`, and the caller may hand the task to the model
 * instead of guessing.
 */

import { CredentialError } from './../credentials.js';

export class FlowError extends Error {
	/**
	 * @param {string} outcome
	 * @param {string} message
	 * @param {boolean} fallback Whether the model could reasonably take over.
	 */
	constructor(outcome, message, fallback = false) {
		super(message);
		this.name = 'FlowError';
		this.outcome = outcome;
		this.fallback = fallback;
	}
}

export const OUTCOME_SUCCEEDED = 'succeeded';
export const OUTCOME_SCHEMA_UNMET = 'result_schema_unmet';
export const OUTCOME_CANCELLED = 'run_cancelled';
export const OUTCOME_FLOW_STUCK = 'flow_stuck';

export class FlowRunner {
	/**
	 * @param {object} deps
	 * @param {object} deps.envelope Parsed envelope.
	 * @param {import('../surface/BrowserSurface.js').BrowserSurface} deps.surface
	 * @param {import('../credentials.js').CredentialStore} deps.credentials
	 * @param {object|null} deps.twoFactor Approval channel, or null.
	 * @param {{extract: Function, describe: Function}|null} deps.extractor
	 * @param {object} deps.config
	 * @param {AbortSignal} deps.signal
	 * @param {(name: string, detail?: object|null) => void} deps.recordStep
	 * @param {(artifact: object) => object} deps.putArtifact
	 */
	constructor(deps) {
		this.envelope = deps.envelope;
		this.surface = deps.surface;
		this.credentials = deps.credentials;
		this.twoFactor = deps.twoFactor ?? null;
		this.extractor = deps.extractor ?? null;
		this.config = deps.config;
		this.signal = deps.signal ?? new AbortController().signal;
		this.recordStep = deps.recordStep ?? (() => {});
		this.putArtifact = deps.putArtifact ?? (() => null);

		/** Values read off the network log by the extractor. */
		this.captured = {};

		/** Result fields the recipe sets directly (e.g. reused_existing_session, notes). */
		this.fields = {};
	}

	/**
	 * Runs a recipe.
	 *
	 * @param {object[]} steps
	 * @returns {Promise<{ok: boolean, outcome: string, result: object|null, error: string|null, fallback?: boolean}>}
	 */
	async run(steps) {
		try {
			await this.surface.open();

			this.step('starting the deterministic flow', { service: this.envelope.service.key });

			const finished = await this.execute(steps);

			if (!finished) {
				// Ran off the end of the recipe without an explicit finish
				return this.finish();
			}

			return finished;
		} catch (error) {
			if (this.signal.aborted) {
				return { ok: false, outcome: OUTCOME_CANCELLED, result: null, error: 'The run was cancelled.' };
			}

			if (error instanceof FlowError) {
				this.step(`the flow stopped: ${error.message}`, { outcome: error.outcome, fallback: error.fallback });
				return { ok: false, outcome: error.outcome, result: null, error: error.message, fallback: error.fallback };
			}

			if (error instanceof CredentialError) {
				return { ok: false, outcome: 'credential_problem', result: null, error: error.message };
			}

			// An unexpected error is exactly where a model might still cope
			this.step(`the flow hit an unexpected error: ${error.message}`);
			return { ok: false, outcome: OUTCOME_FLOW_STUCK, result: null, error: error.message, fallback: true };
		} finally {
			await this.surface.close();
		}
	}

	/**
	 * Executes a list of steps in order. Returns a terminal result if a step
	 * finished or failed the run, otherwise null.
	 *
	 * @param {object[]} steps
	 * @returns {Promise<object|null>}
	 */
	async execute(steps) {
		for (const step of steps) {
			if (this.signal.aborted) {
				throw new FlowError(OUTCOME_CANCELLED, 'cancelled');
			}

			const terminal = await this.one(step);

			if (terminal) {
				return terminal;
			}
		}

		return null;
	}

	/**
	 * Executes one step.
	 *
	 * @param {object} step
	 * @returns {Promise<object|null>} A terminal result, or null to continue.
	 */
	async one(step) {
		switch (step.op) {
			case 'navigate':
				this.step(`opening ${safeHost(step.url)}`);
				await this.surface.go(step.url);
				return null;

			case 'waitFor': {
				const found = await this.surface.waitFor(step.selector, { timeoutMs: step.timeoutMs ?? 15000 });

				if (!found && !step.optional) {
					throw new FlowError(OUTCOME_FLOW_STUCK, `waited for "${step.selector}" but it never appeared`, true);
				}

				return null;
			}

			case 'branchCookie': {
				const present = Boolean(await this.surface.cookie(step.name));
				this.step(`${present ? 'found' : 'no'} ${step.name} cookie`);
				return this.execute(present ? (step.present ?? []) : (step.absent ?? []));
			}

			case 'branchSelector': {
				const present = await this.surface.waitFor(step.selector, { timeoutMs: step.timeoutMs ?? 4000 });
				return this.execute(present ? (step.present ?? []) : (step.absent ?? []));
			}

			case 'branchUrl': {
				const here = this.surface.url();
				const match = [].concat(step.includes).some((fragment) => here.includes(fragment));
				this.step(match ? `on ${step.label ?? 'the branch'} page` : `not on ${step.label ?? 'the branch'} page`);
				return this.execute(match ? (step.present ?? []) : (step.absent ?? []));
			}

			case 'waitForUrl': {
				const ok = await this.surface.waitForUrl([].concat(step.includes), { timeoutMs: step.timeoutMs ?? 60000, signal: this.signal });

				if (!ok && !step.optional) {
					throw new FlowError(step.outcome ?? OUTCOME_FLOW_STUCK, `the page never reached ${[].concat(step.includes).join(' / ')}`, Boolean(step.fallback));
				}

				return null;
			}

			case 'click':
				this.step(`clicking ${step.label ?? step.selector}`);
				await this.surface.clickSelector(step.selector, { timeoutMs: step.timeoutMs ?? 15000 });
				return null;

			case 'fill': {
				const value = this.resolveValue(step.value);
				this.step(`filling ${step.label ?? step.selector}`, { characters: String(value).length });
				await this.surface.fill(step.selector, String(value));
				return null;
			}

			case 'fillCredential': {
				// The value is typed, never logged or returned
				const value = this.credentials.field(this.envelope.service.credentialAlias, step.field);
				this.step(`entering the stored ${step.field}`);
				await this.surface.fill(step.selector, value, { secret: true });
				return null;
			}

			case 'approve': {
				if (!this.twoFactor) {
					throw new FlowError('two_factor_unavailable', 'the sign-in needs an approval but no channel is configured', false);
				}

				this.step('approving the sign-in');
				const { code, note } = await this.twoFactor.collect({
					workDir: this.config.workDir,
					signal: this.signal,
					recordStep: (name, detail) => this.step(name, detail),
				});

				if (code && step.selector) {
					await this.surface.fill(step.selector, code, { secret: true });

					if (step.submit) {
						await this.surface.clickSelector(step.submit, { timeoutMs: 10000 });
					}
				}

				if (note) {
					this.step(note);
				}

				return null;
			}

			case 'waitForCookie': {
				const ok = await this.surface.waitForCookie(step.name, { timeoutMs: step.timeoutMs ?? 60000, signal: this.signal });

				if (!ok) {
					throw new FlowError(step.outcome ?? 'sign_in_incomplete', `the ${step.name} cookie never appeared, so the sign-in did not complete`, false);
				}

				this.step(`the ${step.name} cookie is set`);
				return null;
			}

			case 'capture': {
				this.runCapture();
				return null;
			}

			case 'set':
				this.fields[step.field] = this.resolveValue(step.value);
				return null;

			case 'sleep':
				await delay(step.ms ?? 500, this.signal);
				return null;

			case 'finish':
				return this.finish();

			case 'fail':
				throw new FlowError(step.outcome ?? OUTCOME_FLOW_STUCK, step.reason ?? 'the flow failed', Boolean(step.fallback));

			default:
				throw new FlowError(OUTCOME_FLOW_STUCK, `unknown flow step "${step.op}"`, false);
		}
	}

	/**
	 * Runs the extractor over the network log and merges what it found. The values
	 * stay here; only a summary is logged.
	 */
	runCapture() {
		if (!this.extractor || !this.surface.network) {
			this.step('nothing to capture for this service');
			return;
		}

		const capture = this.extractor.extract(this.surface.network);
		Object.assign(this.captured, capture.values);
		this.step('captured the connection details', { found: capture.found, missing: capture.missing });
	}

	/**
	 * Assembles the result and checks it against the task schema. Extracted values
	 * win over recipe-set fields for the same key, as they came off the wire.
	 *
	 * @returns {object}
	 */
	finish() {
		const result = { ...this.fields, ...this.captured };
		const missing = this.missingFields(result);

		if (missing.length > 0) {
			// A deterministic run that came up short is not something a model can
			// rescue - the values simply were not produced - so no fallback.
			return { ok: false, outcome: OUTCOME_SCHEMA_UNMET, result: null, error: `the result is missing: ${missing.join(', ')}` };
		}

		this.step('flow finished');
		return { ok: true, outcome: OUTCOME_SUCCEEDED, result, error: null };
	}

	/**
	 * @param {object} result
	 * @returns {string[]}
	 */
	missingFields(result) {
		const properties = this.envelope.resultSchema.properties ?? {};

		return (this.envelope.resultSchema.required ?? []).filter((field) => {
			if (!Object.prototype.hasOwnProperty.call(result, field)) {
				return true;
			}

			const value = result[field];

			if (properties[field]?.type === 'string') {
				return typeof value !== 'string';
			}

			return value === undefined || value === null;
		});
	}

	/**
	 * @param {object|{input: string}|{literal: unknown}} value
	 * @returns {unknown}
	 */
	resolveValue(value) {
		if (value && typeof value === 'object') {
			if ('input' in value) {
				return this.envelope.inputs[value.input] ?? '';
			}

			if ('literal' in value) {
				return value.literal;
			}
		}

		return value;
	}

	/**
	 * @param {string} name
	 * @param {object|null} [detail]
	 */
	step(name, detail = null) {
		this.recordStep(String(name), detail ?? null);
	}
}

/**
 * @param {string} url
 * @returns {string}
 */
function safeHost(url) {
	try {
		return new URL(url).host;
	} catch {
		return '(url)';
	}
}

/**
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function delay(ms, signal) {
	return new Promise((resolve) => {
		const onAbort = () => { clearTimeout(timer); resolve(); };
		const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}
