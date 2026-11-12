/**
 * The agent: one task, from envelope to result, over one loop.
 *
 * Look at the screen, ask the model, carry out what it asks, look again - until
 * it calls `finish` with a result, `give_up` with a dead end, or runs out of
 * steps or time. This is the only loop in the project: it drives either surface
 * (browser or desktop) through the same action vocabulary, so there is one place
 * where a run is orchestrated and one place where each rule is enforced.
 *
 * Almost all of the interesting code is about what the loop refuses to do, and
 * that is deliberate. A run holds a signed-in session on a government portal with
 * a real person's credentials behind it. The envelope's standing rules ask the
 * model to behave; rules in a prompt are a request. What actually holds:
 *
 *  - It cannot leave the task's origins. Enforced by the browser surface, checked
 *    after every step; the run ends if the page ends up elsewhere.
 *  - It cannot read a password or a one-time code. The loop resolves those on
 *    this machine and has the surface type them; nothing returns a value to the
 *    model.
 *  - It cannot run forever. Step cap and deadline, both from the envelope and
 *    both held here as well.
 *  - It cannot answer with whatever it likes. A `finish` is checked against the
 *    task's schema, and the model is told what is missing rather than having a
 *    half-filled record accepted.
 *  - For a service with an extractor, it never sees the values being collected.
 *    It navigates; the machine reads the bytes the browser actually sent.
 *
 * The loop produces `{ok, outcome, result, error}` and reports steps and
 * artifacts through injected callbacks, so the same loop serves the HTTP job
 * store and the one-off command-line runner without knowing which it is in.
 */

import { describe, MAX_WAIT_SECONDS, PASSIVE_ACTIONS } from './actions.js';
import { CredentialError, Redactor } from './credentials.js';
import { regionOn } from './view.js';
import { OriginRefused, RunStopped } from './surface/errors.js';
import { extractorFor } from './extractors/index.js';

export const OUTCOME_SUCCEEDED = 'succeeded';
export const OUTCOME_STEP_CAP = 'max_steps_reached';
export const OUTCOME_TIMED_OUT = 'run_timed_out';
export const OUTCOME_CANCELLED = 'run_cancelled';
export const OUTCOME_LEFT_ALLOWED_ORIGINS = 'left_allowed_origins';
export const OUTCOME_SCHEMA_UNMET = 'result_schema_unmet';
export const OUTCOME_CREDENTIAL_PROBLEM = 'credential_problem';
export const OUTCOME_STALLED = 'model_stalled';
export const OUTCOME_AGENT_ERROR = 'agent_error';
export const OUTCOME_STOPPED = 'stopped_by_operator';

/** Times the model is told its result misses the schema before the run is failed. */
const SCHEMA_CORRECTION_ATTEMPTS = 2;

/** Turns with no tool call tolerated before the model is deemed to have stalled. */
const MAX_IDLE_TURNS = 2;

/** How long to let a portal settle after an action before the next screenshot. */
const SETTLE_MS = 600;

export class Agent {
	/**
	 * @param {object} envelope
	 * @param {object} deps
	 * @param {import('./surface/BrowserSurface.js').BrowserSurface|import('./surface/DesktopSurface.js').DesktopSurface} deps.surface
	 * @param {(envelope: object, options: object) => import('./drivers/ModelDriver.js').ModelDriver} deps.makeDriver
	 * @param {import('./credentials.js').CredentialStore} deps.credentials
	 * @param {object|null} deps.twoFactor A two-factor channel, or null.
	 * @param {string} deps.surfaceKind 'browser' or 'desktop'.
	 * @param {object} deps.config
	 * @param {AbortSignal} deps.signal
	 * @param {(name: string, detail?: object|null) => void} [deps.recordStep]
	 * @param {(artifact: object) => object} [deps.putArtifact]
	 */
	constructor(envelope, deps) {
		this.envelope = envelope;
		this.surface = deps.surface;
		this.makeDriver = deps.makeDriver;
		this.credentials = deps.credentials;
		this.twoFactor = deps.twoFactor ?? null;
		this.surfaceKind = deps.surfaceKind;
		this.config = deps.config;
		this.signal = deps.signal ?? new AbortController().signal;
		this.recordStep = deps.recordStep ?? (() => {});
		this.putArtifact = deps.putArtifact ?? (() => null);

		this.redactor = new Redactor();
		this.extractor = extractorFor(envelope.capture ?? envelope.service.key);

		/** Values read off the network log rather than from the model. Readable after a failed run. */
		this.captured = {};

		/** Set when the extractor reports everything required as captured. */
		this.harvestComplete = false;
		this.stepsTaken = 0;
	}

	/**
	 * Runs the task.
	 *
	 * @returns {Promise<{ok: boolean, outcome: string, result: object|null, error: string|null}>}
	 */
	async run() {
		const deadline = Date.now() + this.envelope.limits.timeoutSeconds * 1000;
		const alias = this.envelope.service.credentialAlias;

		let driver;

		try {
			if (this.envelope.service.requiresLogin && alias && !this.credentials.has(alias)) {
				return this.fail(OUTCOME_CREDENTIAL_PROBLEM, `This machine has no credentials configured for "${alias}".`);
			}

			if (alias) {
				this.redactor.register(this.credentials.secrets(alias));
			}

			const offered = this.offeredActions();
			const credentialFields = alias ? this.credentials.typeableFields(alias) : [];

			this.step('starting', {
				service: this.envelope.service.key,
				surface: this.surfaceKind,
				max_steps: this.envelope.limits.maxSteps,
				timeout_seconds: this.envelope.limits.timeoutSeconds,
			});

			await this.surface.open();

			// On the browser the playbook's first step is always "open the portal";
			// the desktop reaches it by working the screen, so there is nothing to do.
			if (this.surface.capabilities.navigate) {
				await this.surface.execute({ type: 'navigate', args: { url: this.envelope.service.url } });
			}

			const first = await this.look();

			driver = this.makeDriver(this.envelope, { offered, surface: this.surfaceKind, signal: this.signal, credentialFields });

			let turn = await driver.start({ view: first });

			return await this.loop(driver, turn, deadline);
		} catch (error) {
			if (this.signal.aborted) {
				return this.end(OUTCOME_CANCELLED, null, 'The run was cancelled.');
			}

			return this.fail(outcomeForError(error), this.redactor.scrub(error.message));
		} finally {
			await driver?.close();
			await this.surface.close();
		}
	}

	/**
	 * The loop.
	 *
	 * @param {object} driver
	 * @param {object} turn
	 * @param {number} deadline
	 * @returns {Promise<object>}
	 */
	async loop(driver, turn, deadline) {
		let schemaAttempts = 0;
		let idleTurns = 0;

		while (true) {
			if (this.signal.aborted) {
				return this.end(OUTCOME_CANCELLED, null, 'The run was cancelled.');
			}

			if (Date.now() >= deadline) {
				return this.fail(OUTCOME_TIMED_OUT, `The run did not finish within ${this.envelope.limits.timeoutSeconds} seconds.`);
			}

			if (this.stepsTaken >= this.envelope.limits.maxSteps) {
				return this.fail(OUTCOME_STEP_CAP, `The run used its ${this.envelope.limits.maxSteps} steps without finishing.`);
			}

			if (turn.note) {
				this.step('the model said', { note: turn.note });
			}

			if (turn.giveUp) {
				return this.fail(turn.giveUp.outcome || OUTCOME_AGENT_ERROR, turn.giveUp.reason || 'The agent stopped.');
			}

			if (turn.finish) {
				const result = this.assemble(turn.finish.result);
				const missing = this.missingFields(result);

				if (missing.length === 0) {
					return this.end(OUTCOME_SUCCEEDED, result, null);
				}

				schemaAttempts++;

				if (schemaAttempts > SCHEMA_CORRECTION_ATTEMPTS) {
					return this.fail(OUTCOME_SCHEMA_UNMET, `The result is still missing: ${missing.join(', ')}.`);
				}

				this.step('the result did not match the schema', { missing, attempt: schemaAttempts });

				turn = await driver.next({
					view: null,
					results: [{
						callId: turn.finish.callId,
						result: {
							ok: false,
							missing_fields: missing,
							message: 'Those required fields were empty or absent. Fill them in and call finish again.',
						},
					}],
				});

				continue;
			}

			if (turn.actions.length === 0) {
				idleTurns++;

				if (idleTurns > MAX_IDLE_TURNS) {
					return this.fail(OUTCOME_STALLED, 'The model stopped issuing commands.');
				}

				this.step('the model answered without a command');
				turn = await driver.say('That was not a command. Use one of the tools, and finish or give up when you are done.');
				continue;
			}

			idleTurns = 0;

			const { results, view } = await this.dispatch(driver, turn.actions);

			if (this.surface.originViolation) {
				return this.fail(OUTCOME_LEFT_ALLOWED_ORIGINS, `The page navigated to ${this.surface.originViolation}, which this task does not permit.`);
			}

			/**
			 * A task whose whole point is the harvest (envelope.finishOnCapture)
			 * ends the moment the harvest is complete, rather than trusting the model
			 * to stop: left to itself it tends to go round again "to be sure".
			 */
			if (this.envelope.finishOnCapture && this.harvestComplete) {
				const result = this.assemble({
					summary: `Captured the session${this.captured.signed_in_as ? ` (signed in as ${this.captured.signed_in_as})` : ''}; finished automatically once everything required was in.`,
					details: '',
				});

				if (this.missingFields(result).length === 0) {
					return this.end(OUTCOME_SUCCEEDED, result, null);
				}
			}

			turn = await driver.next({ view, results });
		}
	}

	/**
	 * Carries out the actions of one turn, in order, stopping the batch at the
	 * first failure.
	 *
	 * The batch is stopped rather than skipped past, because the actions in one
	 * call are a sequence: a click that failed means the type that followed it
	 * would go into whatever had focus before, which is how a password ends up in
	 * a search box.
	 *
	 * @param {object} driver
	 * @param {object[]} actions
	 * @returns {Promise<{results: object[], view: import('./view.js').View|null}>}
	 */
	async dispatch(driver, actions) {
		const results = [];
		let acted = false;
		let producedView = null;

		for (const act of actions) {
			// A call the driver could not even build is reported straight back
			if (act.type === '__invalid__') {
				results.push({ callId: act.callId, result: { ok: false, error: act.error } });
				break;
			}

			this.stepsTaken++;

			let outcome;

			try {
				outcome = await this.carryOut(act);
			} catch (error) {
				// A refused origin or a credential problem ends the run; anything
				// else is reported to the model, which can usually recover.
				if (error instanceof OriginRefused || error instanceof CredentialError || error instanceof RunStopped) {
					throw error;
				}

				this.step(`${describe(act)} failed`, { error: this.redactor.scrub(error.message) });

				if (act.callId) {
					results.push({ callId: act.callId, result: { ok: false, error: this.redactor.scrub(error.message) } });
				}

				break;
			}

			if (outcome.view) {
				producedView = outcome.view;
			}

			if (!PASSIVE_ACTIONS.includes(act.type)) {
				acted = true;
			}

			if (act.callId) {
				results.push({ callId: act.callId, result: outcome.result });
			}

			// A reported failure stops the batch, as a thrown one would
			if (outcome.result && outcome.result.ok === false) {
				break;
			}
		}

		// Decide which screen to show next: a fresh one if anything changed it, the
		// one a screenshot action produced, or none (nothing moved).
		let view = producedView;

		if (acted) {
			await sleep(SETTLE_MS, this.signal);
			view = await this.look();
		}

		return { results, view };
	}

	/**
	 * Carries out one action, dispatching the ones the loop owns here and handing
	 * the screen actions to the surface.
	 *
	 * @param {{type: string, args: object, callId?: string}} act
	 * @returns {Promise<{result: object, view?: import('./view.js').View}>}
	 */
	async carryOut(act) {
		const { type, args } = act;

		switch (type) {
			case 'screenshot': {
				if (args.region) {
					const rect = regionOn(this.surface.view(), args.region);

					if (rect.error) {
						return { result: { ok: false, error: rect.error } };
					}

					const view = await this.look({ region: rect });
					return { result: { ok: true, note: view.note }, view };
				}

				const view = await this.look({ monitor: args.monitor });
				this.step('looked at the screen', { monitor: args.monitor || 'primary' });
				return { result: { ok: true, note: view.note }, view };
			}

			case 'wait': {
				const seconds = Math.min(Math.max(Number(args.seconds) || 0, 0), MAX_WAIT_SECONDS);
				this.step('waited', { seconds, why: args.why || null });
				await sleep(seconds * 1000, this.signal);
				return { result: { ok: true, waited_seconds: seconds } };
			}

			case 'type_credential': {
				const alias = this.envelope.service.credentialAlias;
				const field = this.credentials.field(alias, args.field);

				await this.surface.typeText(field);
				this.step(describe(act));
				return { result: { ok: true } };
			}

			case 'type_two_factor_code': {
				if (!this.twoFactor) {
					return { result: { ok: false, error: 'This task has no two-factor channel.' } };
				}

				const { code, note } = await this.twoFactor.collect({
					workDir: this.config.workDir,
					signal: this.signal,
					recordStep: (name, detail) => this.step(name, detail),
				});

				if (code) {
					await this.surface.typeText(code);
				}

				this.step(describe(act), { note: note ?? null });
				return { result: { ok: true } };
			}

			case 'start_recording': {
				const started = await this.surface.startRecording();
				this.step(started.already ? 'network recording was already on' : 'started recording network traffic', { tabs: started.tabs });

				return {
					result: {
						ok: true,
						note: started.already
							? 'Already recording.'
							: 'Recording now. Only requests from here on are recorded, so trigger the calls capture needs (again, if you already did them), then call capture.',
					},
				};
			}

			case 'capture':
				return { result: this.runExtractor() };

			default: {
				const result = await this.surface.execute(act);
				this.step(describe(act));
				return { result };
			}
		}
	}

	/**
	 * Takes a screenshot and retains it if the envelope asks for every step.
	 *
	 * @param {object} [options]
	 * @returns {Promise<import('./view.js').View>}
	 */
	async look(options) {
		const view = await this.surface.screenshot(options ?? {});

		if (this.envelope.artifacts.retainScreenshots === 'every_step') {
			this.retain(view, `step-${this.stepsTaken}`);
		}

		return view;
	}

	/**
	 * Runs this service's extractor over the network log. The values are kept
	 * here; only the summary of what was found goes back to the model.
	 *
	 * @returns {object}
	 */
	runExtractor() {
		if (!this.extractor) {
			return { ok: false, error: 'This task has nothing to capture.' };
		}

		if (!this.surface.network) {
			return {
				ok: false,
				error: this.surface.capabilities.recordOnDemand
					? 'Nothing has been recorded yet. Call start_recording, trigger the calls again, then capture.'
					: 'This task has nothing to capture.',
			};
		}

		const capture = this.extractor.extract(this.surface.network);

		Object.assign(this.captured, capture.values);
		this.harvestComplete = capture.values.harvested === true;

		this.step('captured the connection details', { found: capture.found, missing: capture.missing });

		return { ok: true, ...this.extractor.describe(capture, this.surface.network) };
	}

	/**
	 * Builds the final result. Anything extracted overrides what the model said
	 * about the same field: the extracted values came off the wire, the model's
	 * are at best a transcription of something it was never shown.
	 *
	 * @param {object} modelResult
	 * @returns {object}
	 */
	assemble(modelResult) {
		return { ...(modelResult && typeof modelResult === 'object' ? modelResult : {}), ...this.captured };
	}

	/**
	 * Required schema fields the result does not satisfy. Presence and emptiness,
	 * not types: a missing key means the model answered something other than the
	 * question. Only strings are held to being non-empty.
	 *
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
	 * Which of the extra tool actions this task gets.
	 *
	 * @returns {string[]}
	 */
	offeredActions() {
		const offered = ['screenshot', 'click', 'move', 'drag', 'scroll', 'type', 'keypress', 'wait'];
		const caps = this.surface.capabilities;

		if (caps.navigate) {
			offered.push('navigate');
		}

		if (this.envelope.service.credentialAlias) {
			offered.push('type_credential');
		}

		if (this.envelope.twoFactor) {
			offered.push('type_two_factor_code');
		}

		if (caps.capture && this.extractor) {
			if (caps.recordOnDemand) {
				offered.push('start_recording');
			}

			offered.push('capture');
		}

		offered.push('finish', 'give_up');

		return offered;
	}

	/**
	 * Writes a screenshot through the injected artifact sink. The bytes are not
	 * returned with the job; KYCDD fetches the ones it wants by id.
	 *
	 * @param {import('./view.js').View} view
	 * @param {string} label
	 */
	retain(view, label) {
		try {
			this.putArtifact({
				kind: 'screenshot',
				mediaType: 'image/png',
				data: Buffer.from(view.base64, 'base64'),
				name: `${label}.png`,
			});
		} catch (error) {
			this.step('a screenshot could not be retained', { error: error.message });
		}
	}

	/**
	 * Records a step, scrubbed, because the log goes back to KYCDD and is read by
	 * people with no need to see a credential.
	 *
	 * @param {string} name
	 * @param {object|null} [detail]
	 */
	step(name, detail = null) {
		this.recordStep(String(this.redactor.scrub(name)), detail ? this.redactor.scrub(detail) : null);
	}

	/**
	 * Ends a run as failed, retaining the last screen if the envelope asks for it
	 * on error.
	 *
	 * @param {string} outcome
	 * @param {string} error
	 * @returns {object}
	 */
	fail(outcome, error) {
		const view = this.surface.view?.();

		if (this.envelope.artifacts.retainScreenshots === 'on_error' && view) {
			this.retain(view, 'failure');
		}

		return this.end(outcome, null, error);
	}

	/**
	 * @param {string} outcome
	 * @param {object|null} result
	 * @param {string|null} error
	 * @returns {object}
	 */
	end(outcome, result, error) {
		this.step(`run ended as ${outcome}`, error ? { error: this.redactor.scrub(error) } : null);

		return {
			ok: outcome === OUTCOME_SUCCEEDED,
			outcome,
			result,
			error: error ? String(this.redactor.scrub(error)) : null,
		};
	}
}

/**
 * @param {Error} error
 * @returns {string}
 */
function outcomeForError(error) {
	if (error instanceof OriginRefused) {
		return OUTCOME_LEFT_ALLOWED_ORIGINS;
	}

	if (error instanceof CredentialError) {
		return OUTCOME_CREDENTIAL_PROBLEM;
	}

	if (error instanceof RunStopped) {
		return OUTCOME_STOPPED;
	}

	return OUTCOME_AGENT_ERROR;
}

/**
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
	return new Promise((resolve) => {
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};

		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);

		signal?.addEventListener('abort', onAbort, { once: true });
	});
}
