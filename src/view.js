/**
 * A view is one screenshot the model was shown, together with the mapping from
 * its pixels back to the surface's own target space.
 *
 * It exists so the agent loop never does coordinate arithmetic and never cares
 * which surface it is driving. The model always gives coordinates in the pixels
 * of the picture it was last shown; the surface produced that picture and knows
 * what rectangle of the real target it covers, so the surface is where a point
 * is turned back into something clickable.
 *
 *  - On the browser, the target is the Puppeteer viewport and a full screenshot
 *    is 1:1, so the mapping is usually the identity.
 *  - On the desktop, the target is the real screen, a whole-screen capture is
 *    reduced, and on a multi-monitor machine the screen does not start at zero,
 *    so both the scale and the origin have to be undone.
 *  - A region ("look closer") is just a view whose covered rectangle is smaller
 *    than the whole, which is what lets a click follow a zoom with no extra
 *    bookkeeping: mapping always runs against whatever picture was last shown.
 *
 * `src{X,Y,W,H}` is the rectangle of the target the image covers, in target
 * pixels. A point (x, y) in the image maps to
 *   (srcX + x * srcW / width, srcY + y * srcH / height).
 */

export class View {
	/**
	 * @param {object} shot
	 * @param {string} shot.base64 The PNG the model is shown.
	 * @param {number} shot.width  Image width (the model's x range).
	 * @param {number} shot.height Image height (the model's y range).
	 * @param {number} shot.srcX   Target-space left edge the image covers.
	 * @param {number} shot.srcY   Target-space top edge.
	 * @param {number} shot.srcW   Target-space width the image covers.
	 * @param {number} shot.srcH   Target-space height.
	 * @param {string} [shot.note] A line for the loop's message to the model.
	 */
	constructor({ base64, width, height, srcX, srcY, srcW, srcH, note = null }) {
		this.base64 = base64;
		this.width = width;
		this.height = height;
		this.srcX = srcX;
		this.srcY = srcY;
		this.srcW = srcW;
		this.srcH = srcH;
		this.note = note;
	}

	/**
	 * How much the target was reduced to make this image. 1 is full size, 2 is
	 * half. Used to warn when small print may not have survived.
	 *
	 * @returns {number}
	 */
	get shrink() {
		return this.width > 0 ? this.srcW / this.width : 1;
	}

	/**
	 * Maps a point on this image to target-space, rounding to whole pixels.
	 *
	 * @param {number} x
	 * @param {number} y
	 * @returns {{x: number, y: number}}
	 */
	toTarget(x, y) {
		return {
			x: Math.round(this.srcX + (x * this.srcW) / this.width),
			y: Math.round(this.srcY + (y * this.srcH) / this.height),
		};
	}

	/**
	 * Maps a rectangle on this image to a target-space rectangle.
	 *
	 * @param {{x: number, y: number, width: number, height: number}} rect
	 * @returns {{x: number, y: number, width: number, height: number}}
	 */
	rectToTarget(rect) {
		const topLeft = this.toTarget(rect.x, rect.y);
		const bottomRight = this.toTarget(rect.x + rect.width, rect.y + rect.height);

		return {
			x: topLeft.x,
			y: topLeft.y,
			width: Math.max(1, bottomRight.x - topLeft.x),
			height: Math.max(1, bottomRight.y - topLeft.y),
		};
	}
}

/**
 * Checks a point the model gave, in the coordinates of the view it was last
 * shown.
 *
 * A point outside the image is almost always the model working from a picture it
 * has since been given a newer version of - often a closer view it has zoomed
 * out of - so it is worth saying so rather than clamping and clicking somewhere
 * arbitrary.
 *
 * @param {View|null} view
 * @param {number} x
 * @param {number} y
 * @returns {{x: number, y: number} | {error: string}}
 */
export function pointOn(view, x, y) {
	if (!view) {
		return { error: 'There is no screenshot yet, so there is nothing to aim at. Call screenshot first.' };
	}

	if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) {
		return { error: 'Those coordinates are not numbers, so nothing was done.' };
	}

	if (x < 0 || y < 0 || x > view.width || y > view.height) {
		return { error: `That point is outside the screenshot, which is ${view.width} by ${view.height}. Nothing was done.` };
	}

	return view.toTarget(Number(x), Number(y));
}

/**
 * Checks and clamps a region the model asked to look closer at, in the
 * coordinates of the view it was last shown. Returns the rectangle in that
 * view's own pixels (not yet mapped to target); the surface maps it.
 *
 * @param {View|null} view
 * @param {{x: number, y: number, width: number, height: number}} region
 * @returns {{x: number, y: number, width: number, height: number} | {error: string}}
 */
export function regionOn(view, region) {
	if (!view) {
		return { error: 'There is no screenshot yet, so there is nothing to look closer at. Call screenshot first.' };
	}

	const x = Number(region?.x);
	const y = Number(region?.y);
	const width = Number(region?.width);
	const height = Number(region?.height);

	if (![x, y, width, height].every((value) => Number.isFinite(value))) {
		return { error: 'That region is not made of numbers, so nothing was done.' };
	}

	if (width < 1 || height < 1) {
		return { error: 'That region has no area, so nothing was done.' };
	}

	if (x >= view.width || y >= view.height || x + width <= 0 || y + height <= 0) {
		return { error: `That region is outside the screenshot, which is ${view.width} by ${view.height}. Nothing was done.` };
	}

	// Clamped rather than refused: a rectangle framed around something near an
	// edge routinely overshoots by a few pixels, and the useful answer is the
	// part that exists.
	const left = Math.max(0, x);
	const top = Math.max(0, y);

	return {
		x: left,
		y: top,
		width: Math.min(x + width, view.width) - left,
		height: Math.min(y + height, view.height) - top,
	};
}
