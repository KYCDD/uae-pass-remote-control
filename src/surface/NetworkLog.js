/**
 * Records what the browser actually sent.
 *
 * This is the part of the agent that makes the Growth job possible at all. The
 * seven values a Growth session consists of are a request header and four
 * numbers buried in JSON request bodies. None of it is on the screen, so no
 * amount of screenshotting and no amount of model capability will produce it.
 *
 * It is recorded over CDP rather than through Puppeteer's own `page.on('request')`
 * for one specific reason: `request.headers()` reports the headers Chrome
 * *intended* to send, and it omits the ones the network stack adds later —
 * including `Cookie`, when the cookies are HttpOnly. Growth's session cookies are
 * HttpOnly, so the header that matters is exactly the one that route cannot see.
 * `Network.requestWillBeSentExtraInfo` reports the headers as they actually went
 * on the wire, which is why both events are listened for and merged.
 *
 * It is also why the playbook tells the agent to read the cookie from a request
 * header and specifically not from `document.cookie`: that would return the
 * non-HttpOnly cookies only, which looks like a plausible cookie string and is
 * missing the session.
 */

/**
 * How many requests to keep. A run makes a few hundred requests, most of them
 * fonts and telemetry; the cap is a guard against a portal that polls, not a
 * tuning knob.
 */
const MAX_ENTRIES = 600;

/**
 * Request bodies above this are truncated. The payloads being read here are a
 * few kilobytes of JSON; anything far larger is an upload and not of interest.
 */
const MAX_POST_DATA_BYTES = 262144;

export class NetworkLog {
	/**
	 * @param {import('puppeteer').Page|null} page The page to record (browser surface).
	 * @param {object} [options]
	 * @param {{send: Function, on: Function, detach: Function}} [options.session] A
	 *        CDP session to record from instead of opening one on a page. The
	 *        desktop surface's ChromeTap passes one that spans every tab of a
	 *        Chrome it did not launch through Puppeteer.
	 */
	constructor(page, { session = null } = {}) {
		this.page = page;
		this.session = session;
		this.cdp = null;

		/** @type {Map<string, object>} keyed by CDP requestId */
		this.entries = new Map();

		/** @type {string[]} insertion order, for eviction and for ordered reads */
		this.order = [];
	}

	/**
	 * Starts recording. Safe to call once per page.
	 */
	async start() {
		this.cdp = this.session ?? await this.page.createCDPSession();

		// maxPostDataSize is what makes postData show up on the event at all
		await this.cdp.send('Network.enable', { maxPostDataSize: MAX_POST_DATA_BYTES });

		/**
		 * The two events can arrive in either order, and for some requests only
		 * one of them arrives at all, so both merge into the same entry rather
		 * than one assuming the other has already been seen.
		 */
		this.cdp.on('Network.requestWillBeSent', (event) => {
			this.merge(event.requestId, {
				url: event.request?.url,
				method: event.request?.method,
				resourceType: event.type,

				// Headers as Chrome intends them: no HttpOnly Cookie here
				intendedHeaders: event.request?.headers ?? {},
				postData: event.request?.postData ?? null,
				postDataTruncated: event.request?.hasPostData === true && !event.request?.postData,
			});
		});

		this.cdp.on('Network.requestWillBeSentExtraInfo', (event) => {
			// Headers as they actually went, Cookie included
			this.merge(event.requestId, { sentHeaders: event.headers ?? {} });
		});
	}

	/**
	 * Stops recording. The entries already collected stay readable.
	 */
	async stop() {
		if (!this.cdp) {
			return;
		}

		try {
			await this.cdp.detach();
		} catch {
			// A page that has already gone takes its session with it
		}

		this.cdp = null;
	}

	/**
	 * @param {string} requestId
	 * @param {object} fields
	 */
	merge(requestId, fields) {
		if (!this.entries.has(requestId)) {
			this.entries.set(requestId, { requestId });
			this.order.push(requestId);

			if (this.order.length > MAX_ENTRIES) {
				this.entries.delete(this.order.shift());
			}
		}

		Object.assign(this.entries.get(requestId), fields);
	}

	/**
	 * Requests whose URL contains `fragment`, oldest first.
	 *
	 * @param {string} fragment
	 * @returns {object[]}
	 */
	matching(fragment) {
		return this.order
			.map((requestId) => this.entries.get(requestId))
			.filter((entry) => entry?.url?.includes(fragment));
	}

	/**
	 * The most recent request whose URL contains `fragment`.
	 *
	 * Most recent rather than first, because a run may search more than once
	 * before it gets a hit, and it is the successful call whose versions are
	 * wanted.
	 *
	 * @param {string} fragment
	 * @returns {object|null}
	 */
	latest(fragment) {
		const matches = this.matching(fragment);

		return matches.length > 0 ? matches[matches.length - 1] : null;
	}

	/**
	 * One header off a recorded request, read from the headers that were actually
	 * sent and falling back to the intended ones.
	 *
	 * Header names are matched case-insensitively: CDP reports them as the stack
	 * produced them, so `Cookie` and `cookie` both turn up in practice.
	 *
	 * @param {object} entry
	 * @param {string} name
	 * @returns {string|null}
	 */
	static header(entry, name) {
		const wanted = name.toLowerCase();

		for (const headers of [entry?.sentHeaders, entry?.intendedHeaders]) {
			for (const [key, value] of Object.entries(headers ?? {})) {
				if (key.toLowerCase() === wanted) {
					return String(value);
				}
			}
		}

		return null;
	}

	/**
	 * A recorded request's body, decoded as JSON.
	 *
	 * @param {object} entry
	 * @returns {object|null} NULL when there was no body, or it was not JSON.
	 */
	static json(entry) {
		if (!entry?.postData) {
			return null;
		}

		try {
			return JSON.parse(entry.postData);
		} catch {
			return null;
		}
	}

	/**
	 * A summary safe to show the model or write to the step log.
	 *
	 * Deliberately does not include headers or bodies. The model is told which
	 * calls the portal has made, which is what it needs in order to know whether
	 * the probe worked and what to do next; the values themselves are extracted
	 * on this machine and never enter the model's context. See src/extractors.
	 *
	 * @returns {object[]}
	 */
	summary() {
		return this.order
			.map((requestId) => this.entries.get(requestId))
			.filter((entry) => entry?.url && entry.method !== 'GET')
			.map((entry) => ({
				method: entry.method,
				url: entry.url.split('?')[0],
				has_body: Boolean(entry.postData),
			}));
	}
}
