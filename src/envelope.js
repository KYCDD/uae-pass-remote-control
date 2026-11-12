/**
 * The inbound task envelope, as KYCDD sends it.
 *
 * The platform side that builds this is App\RemoteBrowser\RemoteInstruction;
 * this is the other half of that contract, and the two have to be changed
 * together. Everything the agent is allowed to know about a task arrives here:
 * there is no prompt, no playbook and no credential stored on this machine, only
 * the alias of one.
 *
 * The envelope is treated as instructions from the platform, but the *inputs*
 * are treated as data. A licence number arriving in `inputs` is typed into a
 * form; it is never read as a direction to the agent. That matters because those
 * values originate with a KYCDD client, and a company name is a field someone
 * else gets to fill in.
 */

/**
 * Envelope formats this agent understands.
 *
 * An unknown version is refused rather than best-guessed. A platform that has
 * been deployed ahead of this machine will be sending fields this code has never
 * heard of, and quietly ignoring them is how a run ends up executing most of a
 * task — which is worse than not starting it, because the half that did run
 * signed in to a portal.
 */
export const SUPPORTED_VERSIONS = ['1'];

/**
 * Ceilings this machine imposes regardless of what the envelope asks for.
 *
 * The platform narrows these per service; this is the backstop for a caller that
 * asks for more. A browser session against a government portal is not something
 * to leave open for an hour because a field said so.
 */
const MAX_TIMEOUT_SECONDS = 1800;
const MAX_STEPS = 120;

/**
 * How screenshots are retained and returned.
 *
 * Worth being explicit, because conflating these two things would break the
 * agent outright: this setting governs which screenshots are KEPT as artifacts
 * and sent back to KYCDD. It has nothing to do with whether the model is shown
 * the screen. A computer-use model cannot operate without seeing it, so the
 * screenshots are always taken and always sent to the driver; `none` means none
 * are stored, which is what a task carrying credentials or an identity token
 * wants.
 */
export const RETAIN_NONE = 'none';
export const RETAIN_ON_ERROR = 'on_error';
export const RETAIN_EVERY_STEP = 'every_step';

export class EnvelopeError extends Error {
	constructor(message) {
		super(message);
		this.name = 'EnvelopeError';
	}
}

/**
 * Validates an envelope and returns it in the shape the rest of the agent uses.
 *
 * @param {object} raw The decoded JSON body of POST /tasks.
 * @returns {object}
 */
export function parseEnvelope(raw) {
	if (!raw || typeof raw !== 'object') {
		throw new EnvelopeError('The task envelope is not an object.');
	}

	if (!SUPPORTED_VERSIONS.includes(String(raw.version))) {
		throw new EnvelopeError(
			`Unsupported envelope version "${raw.version}". This agent speaks: ${SUPPORTED_VERSIONS.join(', ')}.`,
		);
	}

	const service = raw.service ?? {};

	if (!service.key) {
		throw new EnvelopeError('The envelope names no service.');
	}

	const url = String(service.url ?? '');
	let origin;

	try {
		origin = new URL(url).origin;
	} catch {
		throw new EnvelopeError(`The service URL is not a usable URL: "${url}".`);
	}

	const instructions = raw.instructions ?? {};

	if (!Array.isArray(instructions.playbook) || instructions.playbook.length === 0) {
		throw new EnvelopeError('The envelope carries no playbook, so there is nothing to do.');
	}

	const schema = raw.result_schema ?? {};

	if (!Array.isArray(schema.required)) {
		throw new EnvelopeError('The envelope carries no result schema to answer.');
	}

	return {
		version: String(raw.version),
		idempotencyKey: raw.idempotency_key ? String(raw.idempotency_key) : null,

		service: {
			key: String(service.key),
			name: String(service.name ?? service.key),
			url,
			origin,
			requiresLogin: Boolean(service.requires_login),

			// An alias only. The secret is resolved from this machine's own store.
			credentialAlias: service.credential_alias ? String(service.credential_alias) : null,
		},

		/**
		 * The origins this run may visit.
		 *
		 * The service origin is always allowed. A login that is delegated
		 * elsewhere — Growth hands its sign-in to UAE Pass on another host — needs
		 * that host allowed too, and the envelope has no field for it, so it is
		 * resolved from this machine's configuration against the credential alias.
		 * Deriving it from anything the task itself says would make the allowlist
		 * worthless: a task could then simply name the host it wanted to visit.
		 */
		allowedOrigins: [origin],

		// Values to type into the portal. Data, never instructions.
		inputs: isPlainObject(raw.inputs) ? raw.inputs : {},

		instructions: {
			operatingRules: asStringArray(instructions.operating_rules),
			playbook: asStringArray(instructions.playbook),
			deadEnds: isPlainObject(instructions.dead_ends) ? instructions.dead_ends : {},
		},

		resultSchema: schema,

		limits: {
			timeoutSeconds: clamp(raw.limits?.timeout_seconds, 60, MAX_TIMEOUT_SECONDS, 600),
			maxSteps: clamp(raw.limits?.max_steps, 1, MAX_STEPS, 60),
		},

		artifacts: {
			retainScreenshots: retainMode(raw.artifacts?.screenshots),
			captureDocuments: Boolean(raw.artifacts?.capture_documents),
		},

		twoFactor: raw.two_factor
			? {
					channel: String(raw.two_factor.channel ?? ''),
					reference: raw.two_factor.reference ? String(raw.two_factor.reference) : null,
				}
			: null,

		// Correlation only. Never shown to the model; it has no use for it.
		context: isPlainObject(raw.context) ? raw.context : {},
	};
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function retainMode(value) {
	const mode = String(value ?? RETAIN_ON_ERROR);

	return [RETAIN_NONE, RETAIN_ON_ERROR, RETAIN_EVERY_STEP].includes(mode) ? mode : RETAIN_ON_ERROR;
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function clamp(value, min, max, fallback) {
	const number = Number(value);

	if (!Number.isFinite(number)) {
		return fallback;
	}

	return Math.min(Math.max(Math.trunc(number), min), max);
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function asStringArray(value) {
	return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
