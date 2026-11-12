/**
 * Surface errors that the agent loop needs to recognise by type.
 *
 * Kept in their own module, free of any heavy import, so the loop and the task
 * wiring can `instanceof`-check them without pulling in Puppeteer. That is what
 * lets the desktop-only server run with no browser dependency installed: nothing
 * on its path imports BrowserSurface, which is the only file that loads
 * Puppeteer.
 */

export class OriginRefused extends Error {
	constructor(url) {
		super(`Refused to visit ${url}: it is outside this task's allowed origins.`);
		this.name = 'OriginRefused';
		this.url = url;
	}
}

/**
 * The operator stopped the run by hand (the desktop failsafe: the pointer pushed
 * into the top-left corner of the main screen). Ends the run at once - it is
 * never reported back to the model as something to recover from.
 */
export class RunStopped extends Error {
	constructor(message = 'The operator stopped the run.') {
		super(message);
		this.name = 'RunStopped';
	}
}
