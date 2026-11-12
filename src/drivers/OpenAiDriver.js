/**
 * The OpenAI driver, over the Responses API with function tools.
 *
 * One driver serves both surfaces, because the tools it offers are the action
 * vocabulary (src/actions.js) rather than anything surface-specific: click, type
 * and the rest are function calls carrying coordinates in screenshot pixels,
 * which mean the same thing whether a browser or the desktop carries them out.
 * That is what lets the loop above be surface-agnostic.
 *
 * Chosen first because KYCDD already runs OpenAI everywhere, so this is one
 * vendor, one key, one bill. Written against the HTTP API with `fetch` rather
 * than the SDK on purpose: this runs on a desktop box that may sit offline for
 * weeks, and a pinned SDK is one more thing to keep current for no gain when the
 * request is a JSON object and the response is a JSON object.
 *
 * The driver owns the conversation. The loop hands it a view and the results of
 * the last turn's tool calls; it keeps the running `input`, trims old images
 * (they dominate the cost of a long run and an old screen is worthless), echoes
 * each turn's function calls before their outputs as the API requires, and turns
 * one response into a Turn.
 */

import { action, ActionError } from '../actions.js';
import { ModelDriver, composeTask } from './ModelDriver.js';

/** Status codes worth trying again: rate limiting and the transient 5xx family. */
const RETRYABLE_STATUSES = [429, 500, 502, 503, 504];
const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 1000;

export class OpenAiDriverError extends Error {
	constructor(message) {
		super(message);
		this.name = 'OpenAiDriverError';
	}
}

export class OpenAiDriver extends ModelDriver {
	/**
	 * @param {object} envelope
	 * @param {object} options {config, offered, surface}
	 */
	constructor(envelope, options = {}) {
		super(envelope, options);

		this.config = options.config;
		this.instructions = composeTask(envelope, { offered: options.offered ?? [], surface: options.surface, credentialFields: options.credentialFields });
		this.tools = this.toolSpecs().map((spec) => ({ type: 'function', ...spec }));

		if (!this.config?.apiKey) {
			throw new OpenAiDriverError('No model API key is configured.');
		}

		/** The running conversation. */
		this.input = [];

		/** Raw function_call items from the last response, echoed before their outputs. */
		this.pendingCalls = [];
	}

	/**
	 * @param {{view: import('../view.js').View}} context
	 * @returns {Promise<import('./types.js').Turn>}
	 */
	async start({ view }) {
		this.input.push({
			role: 'user',
			content: [
				{ type: 'input_text', text: 'This is the screen as it is now. Begin.' },
				image(view),
			],
		});

		return this.interpret(await this.request());
	}

	/**
	 * @param {{view: import('../view.js').View|null, results: object[]}} feedback
	 * @returns {Promise<import('./types.js').Turn>}
	 */
	async next({ view, results }) {
		// The model's own calls must be in the history before their outputs
		for (const item of this.pendingCalls) {
			this.input.push(item);
		}

		this.pendingCalls = [];

		for (const { callId, result } of results ?? []) {
			this.input.push({
				type: 'function_call_output',
				call_id: callId,
				output: JSON.stringify(result),
			});
		}

		if (view) {
			this.input.push({
				role: 'user',
				content: [
					{ type: 'input_text', text: view.note ? `This is the screen now. ${view.note}` : 'This is the screen now.' },
					image(view),
				],
			});
		}

		this.trimImages(this.config.screenshotHistory);

		return this.interpret(await this.request());
	}

	/**
	 * Sends a plain prompt (a nudge when the model talked instead of acting) and
	 * asks again, with no tool outputs and no new screenshot.
	 *
	 * @param {string} text
	 * @returns {Promise<import('./types.js').Turn>}
	 */
	async say(text) {
		for (const item of this.pendingCalls) {
			this.input.push(item);
		}

		this.pendingCalls = [];
		this.input.push({ role: 'user', content: [{ type: 'input_text', text }] });
		this.trimImages(this.config.screenshotHistory);

		return this.interpret(await this.request());
	}

	/**
	 * Turns one response into a Turn.
	 *
	 * @param {object} response
	 * @returns {import('./types.js').Turn}
	 */
	interpret(response) {
		const turn = { actions: [], finish: null, giveUp: null, note: null };
		const notes = [];

		this.pendingCalls = [];

		for (const item of response.output ?? []) {
			if (item.type === 'function_call') {
				this.pendingCalls.push(item);

				const args = parseArguments(item.arguments);

				if (item.name === 'finish') {
					turn.finish = { result: args.result ?? args, callId: item.call_id };
					continue;
				}

				if (item.name === 'give_up') {
					turn.giveUp = { outcome: String(args.outcome ?? 'unknown'), reason: String(args.reason ?? ''), callId: item.call_id };
					continue;
				}

				try {
					turn.actions.push({ ...action(item.name, args), callId: item.call_id });
				} catch (error) {
					// A malformed call is reported straight back as its own output,
					// so the model corrects it rather than the run failing
					turn.actions.push({
						type: '__invalid__',
						callId: item.call_id,
						error: error instanceof ActionError ? error.message : String(error.message),
					});
				}

				continue;
			}

			if (item.type === 'message') {
				for (const content of item.content ?? []) {
					if (content.type === 'output_text' && content.text) {
						notes.push(content.text);
					}
				}
			}
		}

		turn.note = notes.length > 0 ? notes.join(' ').slice(0, 2000) : null;

		return turn;
	}

	/**
	 * Replaces all but the newest few images in the conversation with a line
	 * saying one was there, so the narrative survives without the pixels.
	 *
	 * @param {number} keep
	 */
	trimImages(keep) {
		const withImages = [];

		for (let index = 0; index < this.input.length; index++) {
			const item = this.input[index];

			if (Array.isArray(item?.content) && item.content.some((part) => part?.type === 'input_image')) {
				withImages.push(index);
			}
		}

		for (const index of withImages.slice(0, Math.max(0, withImages.length - keep))) {
			this.input[index] = {
				role: this.input[index].role,
				content: this.input[index].content
					.filter((part) => part?.type !== 'input_image')
					.concat([{ type: 'input_text', text: '(an earlier screenshot was here, since replaced by a newer one)' }]),
			};
		}
	}

	/**
	 * One call to the Responses API, with retry on the transient failures.
	 *
	 * @returns {Promise<object>}
	 */
	async request() {
		const body = {
			model: this.config.model,
			instructions: this.instructions,
			input: this.input,
			tools: this.tools,
			tool_choice: 'auto',
			store: this.config.storeConversation,
		};

		if (this.config.reasoningEffort) {
			body.reasoning = { effort: this.config.reasoningEffort };
		}

		let lastError = null;

		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			const { signal, release } = this.options.signal
				? anySignal([this.options.signal, AbortSignal.timeout(this.config.modelTimeoutSeconds * 1000)])
				: { signal: AbortSignal.timeout(this.config.modelTimeoutSeconds * 1000), release: () => {} };

			let response;

			try {
				response = await fetch(`${this.config.apiBaseUrl}/responses`, {
					method: 'POST',
					headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
					body: JSON.stringify(body),
					signal,
				});
			} catch (error) {
				release();

				if (this.options.signal?.aborted) {
					throw new OpenAiDriverError('The run was cancelled while waiting for the model.');
				}

				lastError = error;

				if (attempt === MAX_ATTEMPTS) {
					break;
				}

				await backoff(attempt, null);
				continue;
			}

			if (response.ok) {
				try {
					return await response.json();
				} finally {
					release();
				}
			}

			release();

			const detail = await readError(response);

			if (!RETRYABLE_STATUSES.includes(response.status) || attempt === MAX_ATTEMPTS) {
				throw new OpenAiDriverError(`The model answered HTTP ${response.status}: ${detail}`);
			}

			lastError = new OpenAiDriverError(`HTTP ${response.status}: ${detail}`);
			await backoff(attempt, response.headers.get('retry-after'));
		}

		throw new OpenAiDriverError(`The model could not be reached after ${MAX_ATTEMPTS} attempts: ${lastError ? lastError.message : 'unknown error'}`);
	}
}

/**
 * @param {import('../view.js').View} view
 * @returns {object}
 */
function image(view) {
	return { type: 'input_image', image_url: `data:image/png;base64,${view.base64}`, detail: 'high' };
}

/**
 * @param {string|object} args
 * @returns {object}
 */
function parseArguments(args) {
	if (args && typeof args === 'object') {
		return args;
	}

	try {
		return JSON.parse(args ?? '{}');
	} catch {
		return {};
	}
}

/**
 * @param {number} attempt
 * @param {string|null} retryAfter
 * @returns {Promise<void>}
 */
async function backoff(attempt, retryAfter) {
	const advised = retryAfter ? Number.parseFloat(retryAfter) * 1000 : NaN;
	const delay = Number.isFinite(advised) && advised > 0 ? advised : BASE_BACKOFF_MS * 2 ** (attempt - 1);

	await new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * @param {Response} response
 * @returns {Promise<string>}
 */
async function readError(response) {
	try {
		const text = await response.text();

		try {
			return JSON.parse(text).error?.message || text.slice(0, 500);
		} catch {
			return text.slice(0, 500);
		}
	} catch {
		return response.statusText || 'no detail';
	}
}

/**
 * Combines abort signals, since AbortSignal.any is not in Node 18. `release`
 * removes the listeners again: the run's signal lives for the whole run, and a
 * listener left on it per model request is a leak (Node warns after ten).
 *
 * @param {AbortSignal[]} signals
 * @returns {{signal: AbortSignal, release: () => void}}
 */
function anySignal(signals) {
	if (typeof AbortSignal.any === 'function') {
		return { signal: AbortSignal.any(signals), release: () => {} };
	}

	const controller = new AbortController();
	const attached = [];

	for (const signal of signals) {
		if (signal.aborted) {
			controller.abort(signal.reason);
			break;
		}

		const onAbort = () => controller.abort(signal.reason);
		signal.addEventListener('abort', onAbort, { once: true });
		attached.push([signal, onAbort]);
	}

	return {
		signal: controller.signal,
		release: () => attached.forEach(([signal, onAbort]) => signal.removeEventListener('abort', onAbort)),
	};
}
