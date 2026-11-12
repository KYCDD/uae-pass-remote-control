/**
 * Chooses the model driver.
 *
 * One entry today. The registry exists because the choice was made reversible on
 * purpose: KYCDD runs OpenAI everywhere else, so OpenAI is what this starts on,
 * but computer-use is the one job where a different model might clearly do
 * better, and that should be a configuration change rather than a rewrite.
 *
 * A second driver has to do exactly what OpenAiDriver does: offer the actions of
 * src/actions.js as tools and turn the model's calls back into them. Nothing
 * outside src/drivers may branch on which one is running.
 */

import { OpenAiDriver } from './OpenAiDriver.js';

const DRIVERS = {
	openai: (envelope, options) => new OpenAiDriver(envelope, options),
};

/**
 * @param {object} config
 * @returns {(envelope: object, options: object) => import('./ModelDriver.js').ModelDriver}
 */
export function driverFactory(config) {
	const key = String(config.driver || 'openai').toLowerCase();
	const factory = DRIVERS[key];

	if (!factory) {
		throw new Error(`No model driver named "${key}". Available: ${Object.keys(DRIVERS).join(', ')}.`);
	}

	return (envelope, options) => factory(envelope, { ...options, config });
}
