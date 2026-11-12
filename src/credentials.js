/**
 * The credential store, one-time codes, and the redactor that keeps secrets out
 * of everything that leaves this machine.
 *
 * KYCDD never sends a secret. An envelope names a `credential_alias` and this
 * machine resolves it, which is what lets a portal password be rotated here
 * without a platform deploy, and what keeps portal credentials off the wire.
 *
 * An alias can be defined in two places, and both are read on every lookup so a
 * rotated password takes effect on the next task without a restart:
 *
 *  - credentials.json (see credentials.example.json):
 *        { "growth_uae_pass": { "username": "...", "password": "...",
 *                               "login_origins": ["https://id.moec.gov.ae"] } }
 *
 *  - environment variables, which override the file field by field:
 *        REMOTE_AGENT_CRED_GROWTH_UAE_PASS_USERNAME
 *        REMOTE_AGENT_CRED_GROWTH_UAE_PASS_PASSWORD
 *        REMOTE_AGENT_CRED_GROWTH_UAE_PASS_LOGIN_ORIGINS   (comma-separated)
 *
 * `login_origins` is not optional bookkeeping. Growth delegates its sign-in to
 * UAE Pass on a different host, so a run has to be allowed to leave growth.gov.ae
 * and come back. If that host were taken from the task envelope, the browser's
 * origin allowlist would be worthless: a task could name whatever host it liked
 * and the agent would type a password into it. Configured next to the
 * credential, by whoever administers this machine, it means something.
 *
 * The model is told a credential exists and given a tool that types it, never
 * the value. It cannot repeat into its notes or its result a string it was never
 * shown.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * An alias has to look like one before it becomes part of a variable name, so
 * that a malformed envelope cannot go reading arbitrary environment.
 */
const ALIAS_PATTERN = /^[a-z0-9_]{1,64}$/;

/** The fields a run may type. */
export const TYPEABLE_FIELDS = ['username', 'password'];

/** Everything that is redacted from logs, including fields that are never typed. */
const SECRET_FIELDS = ['username', 'password', 'totp_secret'];

const ENV_PREFIX = 'REMOTE_AGENT_CRED_';

/**
 * How often to look for a one-time code, and how long to keep looking. Polling a
 * dropped file is the mechanism KYCDD's own scrapers use (`get2faCodeFromFile` in
 * puppeteer/Handler.js in the KYCDD repository), so whoever operates this
 * machine already knows the drill.
 */
const CODE_POLL_MS = 1000;
export const CODE_TIMEOUT_MS = 180000;

export class CredentialError extends Error {
	constructor(message) {
		super(message);
		this.name = 'CredentialError';
	}
}

export class CredentialStore {
	/**
	 * @param {object} options
	 * @param {string|null} options.file JSON file of aliases. A missing file is
	 *                                   fine when the environment defines them.
	 * @param {object} [options.env]
	 */
	constructor({ file, env = process.env }) {
		this.file = file;
		this.env = env;
	}

	/**
	 * Every alias either source defines.
	 *
	 * @returns {string[]}
	 */
	aliases() {
		const fromEnv = Object.keys(this.env)
			.filter((name) => name.startsWith(ENV_PREFIX) && /_(USERNAME|PASSWORD)$/.test(name))
			.map((name) => name.slice(ENV_PREFIX.length).replace(/_(USERNAME|PASSWORD)$/, '').toLowerCase());

		return [...new Set([...Object.keys(this.readFile()), ...fromEnv])].sort();
	}

	/**
	 * Whether an alias is usable for sign-in, without exposing it. Used to fail a
	 * run before a sign-in page is reached rather than at it.
	 *
	 * Only a username is required. Some portals take no password at all - UAE Pass
	 * signs in on just the Emirates ID and then approves on the mobile app - so a
	 * password is optional, and insisting on one would reject a perfectly usable
	 * credential.
	 *
	 * @param {string} alias
	 * @returns {boolean}
	 */
	has(alias) {
		return this.typeableFields(alias).includes('username');
	}

	/**
	 * The credential fields this alias actually carries, so a run only offers to
	 * type the ones that exist (and never promises a password it does not have).
	 *
	 * @param {string} alias
	 * @returns {string[]} A subset of TYPEABLE_FIELDS.
	 */
	typeableFields(alias) {
		let credential;

		try {
			credential = this.get(alias);
		} catch {
			return [];
		}

		return TYPEABLE_FIELDS.filter((field) => typeof credential[field] === 'string' && credential[field] !== '');
	}

	/**
	 * One field of one credential.
	 *
	 * @param {string} alias
	 * @param {string} field One of TYPEABLE_FIELDS.
	 * @returns {string}
	 */
	field(alias, field) {
		if (!TYPEABLE_FIELDS.includes(field)) {
			throw new CredentialError(`"${field}" is not a credential field this agent will type.`);
		}

		const value = this.get(alias)[field];

		if (typeof value !== 'string' || value === '') {
			throw new CredentialError(`The credential "${alias}" has no "${field}".`);
		}

		return value;
	}

	/**
	 * The origins a run using this credential may visit, on top of the service's
	 * own origin.
	 *
	 * @param {string} alias
	 * @returns {string[]}
	 */
	loginOrigins(alias) {
		const origins = this.get(alias).login_origins;

		if (!Array.isArray(origins)) {
			return [];
		}

		return origins
			.map((origin) => {
				try {
					return new URL(String(origin).trim()).origin;
				} catch {
					return null;
				}
			})
			.filter(Boolean);
	}

	/**
	 * Every secret string this alias could put on screen or in a log, so the
	 * redactor can be told about them before any of them is typed.
	 *
	 * @param {string} alias
	 * @returns {string[]}
	 */
	secrets(alias) {
		const credential = this.get(alias);

		return SECRET_FIELDS.map((field) => credential[field]).filter((value) => typeof value === 'string');
	}

	/**
	 * @param {string} alias
	 * @returns {object}
	 */
	get(alias) {
		const key = String(alias ?? '').toLowerCase();

		if (!ALIAS_PATTERN.test(key)) {
			throw new CredentialError(`"${alias}" is not a usable credential alias.`);
		}

		const credential = { ...(this.readFile()[key] ?? {}) };
		const prefix = `${ENV_PREFIX}${key.toUpperCase()}_`;

		for (const field of SECRET_FIELDS) {
			const value = this.env[`${prefix}${field.toUpperCase()}`];

			if (typeof value === 'string' && value !== '') {
				credential[field] = field === 'username' ? value.trim() : value;
			}
		}

		const origins = String(this.env[`${prefix}LOGIN_ORIGINS`] ?? '').trim();

		if (origins) {
			credential.login_origins = origins.split(',').map((origin) => origin.trim()).filter(Boolean);
		}

		if (Object.keys(credential).length === 0) {
			throw new CredentialError(`No credential is configured on this machine under the alias "${key}".`);
		}

		return credential;
	}

	/**
	 * @returns {object}
	 */
	readFile() {
		if (!this.file || !fs.existsSync(this.file)) {
			return {};
		}

		let parsed;

		try {
			parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
		} catch (error) {
			throw new CredentialError(`The credential file at ${this.file} could not be read: ${error.message}`);
		}

		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new CredentialError(`The credential file at ${this.file} is not an object of aliases.`);
		}

		// Comments in the example file are not aliases
		return Object.fromEntries(Object.entries(parsed).filter(([key]) => !key.startsWith('_')));
	}
}

/**
 * Waits for a one-time code to be dropped into `<dir>/2fa.txt`.
 *
 * The file is deleted as soon as it is read. A code left on disk is a code that
 * gets used twice, and the second use is always the confusing one.
 *
 * @param {object} options
 * @param {string} options.dir
 * @param {string} options.channel Only used in the messages.
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<string>}
 */
export function waitForCode({ dir, channel, signal, timeoutMs = CODE_TIMEOUT_MS }) {
	const file = path.join(dir, '2fa.txt');

	fs.mkdirSync(dir, { recursive: true });

	return new Promise((resolve, reject) => {
		const deadline = Date.now() + timeoutMs;

		const poll = setInterval(() => {
			if (signal?.aborted) {
				clearInterval(poll);
				reject(new Error('The run was cancelled while waiting for a one-time code.'));
				return;
			}

			if (Date.now() > deadline) {
				clearInterval(poll);
				reject(new Error(`No ${channel} code arrived within ${Math.round(timeoutMs / 1000)} seconds.`));
				return;
			}

			let code;

			try {
				code = fs.readFileSync(file, 'utf8').trim();
			} catch {
				// Not there yet, which is the normal case
				return;
			}

			clearInterval(poll);

			try {
				fs.unlinkSync(file);
			} catch (error) {
				console.error(`[credentials] could not remove the code file: ${error.message}`);
			}

			if (!code) {
				reject(new Error('The code file was empty.'));
				return;
			}

			resolve(code);
		}, CODE_POLL_MS);
	});
}

/**
 * Scrubs known secrets out of text on its way off this machine.
 *
 * This is a backstop, not the mechanism. Secrets are kept out of the step log by
 * never putting them there - see `describe()` in src/actions.js, which reports
 * that a credential field was typed rather than what was typed. The redactor
 * catches what that discipline misses: a portal that echoes a username into an
 * error message, a model that repeats something back in its notes, an exception
 * whose message quotes the input it choked on.
 *
 * Short values are not registered. Redacting a three-character string out of
 * every log line would turn the log into a mess and tell an attacker that the
 * string was there.
 */
export class Redactor {
	constructor() {
		this.secrets = new Set();
	}

	/**
	 * @param {string[]} values
	 */
	register(values) {
		for (const value of values) {
			if (typeof value === 'string' && value.length >= 4) {
				this.secrets.add(value);
			}
		}
	}

	/**
	 * @param {unknown} value Anything; objects and arrays are walked.
	 * @returns {unknown}
	 */
	scrub(value) {
		if (typeof value === 'string') {
			let scrubbed = value;

			for (const secret of this.secrets) {
				if (scrubbed.includes(secret)) {
					scrubbed = scrubbed.split(secret).join('[redacted]');
				}
			}

			return scrubbed;
		}

		if (Array.isArray(value)) {
			return value.map((entry) => this.scrub(entry));
		}

		if (value && typeof value === 'object') {
			return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, this.scrub(entry)]));
		}

		return value;
	}
}
