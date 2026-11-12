/**
 * The registry of deterministic recipes.
 *
 * A recipe is a service worked by script rather than by the model (see
 * FlowRunner). A service with no recipe here, or whose recipe is not ready
 * (its selectors are not configured), is worked by the model instead.
 */

import * as growthSession from './recipes/growthSession.js';

const RECIPES = {
	growth_session: growthSession,
};

/**
 * The recipe for a service, or null if there is none.
 *
 * @param {string} serviceKey
 * @returns {{ready: (config: object) => boolean, build: (envelope: object, config: object) => object[]} | null}
 */
export function recipeFor(serviceKey) {
	return RECIPES[serviceKey] ?? null;
}
