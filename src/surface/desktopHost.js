/**
 * The Node side of direct desktop control.
 *
 * Talks to desktop-host.ps1 over a pipe: one JSON request per line out, one JSON
 * response per line back, correlated by id. The host is started on first use and
 * kept alive for the run, because compiling its P/Invoke types costs a second or
 * two and a run makes dozens of calls.
 *
 * Why this rather than browser automation: at this level there is no difference
 * between a browser, a native window, a Windows file dialog and an IE-mode page,
 * so the same handful of commands drives any legacy service the machine can
 * display. The cost is that nothing here knows what a "button" is - the model
 * reads the screen and aims, which is why screenshots and coordinate mapping
 * matter more than they would with a DOM underneath.
 *
 * Coordinates are the subtle part. The host captures the screen and scales it
 * down before sending it anywhere, so the image the model sees is smaller than
 * the screen it describes. Anything the model points at therefore has to be
 * scaled back up before it becomes a click. Every screenshot result carries the
 * sizes needed to do that; turning them into a {@link View} and mapping a point
 * back to the screen is {@link ../view.js}'s job, and DesktopSurface's.
 */

import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// desktop-host.ps1 sits next to this file
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * How long to wait for the host to finish compiling and report ready.
 */
const START_TIMEOUT_MS = 30000;

/**
 * How long any single command may take. Generous because a full-screen capture
 * on a scaled 4K display is not instant, and a drag deliberately moves in steps.
 */
const CALL_TIMEOUT_MS = 60000;

/**
 * Fallbacks for when this module is used without config - in a one-off script,
 * or a test. Normal runs pass these in from config.js, which is where the
 * environment is read.
 */
const DEFAULT_POWERSHELL = 'powershell.exe';
const DEFAULT_MAX_SHRINK = 1.5;
const DEFAULT_MAX_SCREENSHOT_WIDTH = 1920;
const DEFAULT_MIN_SCREENSHOT_WIDTH = 1024;

class Desktop {
    /**
     * @param {string} workDir Where screenshots are written.
     * @param {{powershell?: string, screenshotWidth?: number|null, maxShrink?: number, maxScreenshotWidth?: number, minScreenshotWidth?: number}} [options]
     */
    constructor(workDir, options = {}) {
        this.workDir = workDir;
        this.powershell = options.powershell || DEFAULT_POWERSHELL;

        // An override. Null is the normal case: work it out from the screen.
        this.screenshotWidth = options.screenshotWidth || null;

        this.maxShrink = options.maxShrink || DEFAULT_MAX_SHRINK;
        this.maxScreenshotWidth = options.maxScreenshotWidth || DEFAULT_MAX_SCREENSHOT_WIDTH;
        this.minScreenshotWidth = options.minScreenshotWidth || DEFAULT_MIN_SCREENSHOT_WIDTH;

        this.screen = null;
        this.host = null;
        this.ready = null;
        this.buffer = '';
        this.pending = new Map();
        this.nextId = 1;
    }

    /**
     * Starts the host, once.
     *
     * @returns {Promise<void>}
     */
    start() {
        if (this.ready) {
            return this.ready;
        }

        fs.mkdirSync(this.workDir, {recursive: true});

        this.ready = new Promise((resolve, reject) => {
            const script = path.join(__dirname, 'desktop-host.ps1');

            /**
             * -NoProfile so an operator's profile cannot print into the protocol
             * stream, and -ExecutionPolicy Bypass because this script is not
             * signed and sits in a checkout rather than an installed location.
             */
            this.host = spawn(this.powershell, [
                '-NoProfile',
                '-NonInteractive',
                '-ExecutionPolicy', 'Bypass',
                '-File', script,
            ], {windowsHide: true});

            const startTimer = setTimeout(() => {
                reject(new Error('The desktop host did not start within 30 seconds.'));
            }, START_TIMEOUT_MS);

            this.host.stdout.setEncoding('utf8');
            this.host.stdout.on('data', (chunk) => this.consume(chunk));

            this.host.stderr.setEncoding('utf8');
            this.host.stderr.on('data', (chunk) => {
                const text = String(chunk);

                if (text.includes('[desktop-host] ready')) {
                    clearTimeout(startTimer);
                    resolve();
                    return;
                }

                // The host's own diagnostics, kept off the protocol stream
                console.error(`[desktop] ${text.trim()}`);
            });

            this.host.on('exit', (code) => {
                clearTimeout(startTimer);

                // Anything still waiting will never be answered now
                for (const [, waiting] of this.pending) {
                    waiting.reject(new Error(`The desktop host exited (code ${code}).`));
                }

                this.pending.clear();
                this.host = null;
                this.ready = null;

                reject(new Error(`The desktop host exited during startup (code ${code}).`));
            });

            this.host.on('error', (error) => {
                clearTimeout(startTimer);
                reject(new Error(`The desktop host could not be started: ${error.message}`));
            });
        });

        return this.ready;
    }

    /**
     * Reassembles whole lines out of the pipe and answers whatever they resolve.
     *
     * @param {string} chunk
     * @returns {void}
     */
    consume(chunk) {
        this.buffer += chunk;

        let newline = this.buffer.indexOf('\n');

        while (newline !== -1) {
            const line = this.buffer.slice(0, newline).trim();
            this.buffer = this.buffer.slice(newline + 1);
            newline = this.buffer.indexOf('\n');

            if (!line) {
                continue;
            }

            let response;

            try {
                response = JSON.parse(line);
            } catch (error) {
                // Not protocol. Shown rather than swallowed, because it usually
                // means something in the host is writing to the wrong stream.
                console.error(`[desktop] unparseable line: ${line.slice(0, 200)}`);
                continue;
            }

            const waiting = this.pending.get(response.id);

            if (!waiting) {
                continue;
            }

            this.pending.delete(response.id);
            clearTimeout(waiting.timer);

            if (response.ok) {
                waiting.resolve(response);
            } else {
                waiting.reject(new Error(response.error || 'The desktop host reported a failure.'));
            }
        }
    }

    /**
     * Sends one command and waits for its answer.
     *
     * @param {string} command
     * @param {object} params
     * @returns {Promise<object>}
     */
    async call(command, params = {}) {
        await this.start();

        const id = String(this.nextId++);

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`The desktop command "${command}" did not answer within 60 seconds.`));
            }, CALL_TIMEOUT_MS);

            this.pending.set(id, {resolve, reject, timer});
            this.host.stdin.write(`${JSON.stringify({id, command, ...params})}\n`);
        });
    }

    /**
     * The screen this machine actually has, asked once.
     *
     * @returns {Promise<{width: number, height: number, x: number, y: number}>}
     */
    async measure() {
        if (!this.screen) {
            this.screen = await this.call('screen_size');
        }

        return this.screen;
    }

    /**
     * How wide to capture something of a given width.
     *
     * The screen size is unknown until the agent is running on the machine, so
     * this works from the ratio rather than from a fixed output size: shrink by
     * `maxShrink` for legibility, but never below the floor, never above the
     * token-budget ceiling, and never scale anything up.
     *
     * @param {number} sourceWidth
     * @returns {number}
     */
    captureWidthFor(sourceWidth) {
        if (this.screenshotWidth) {
            return Math.min(this.screenshotWidth, sourceWidth);
        }

        const byRatio = Math.round(sourceWidth / this.maxShrink);
        const floor = Math.min(this.minScreenshotWidth, sourceWidth);
        const ceiling = Math.min(this.maxScreenshotWidth, sourceWidth);

        return Math.max(floor, Math.min(byRatio, ceiling));
    }

    /**
     * Captures the screen.
     *
     * The primary monitor by default. On a machine whose virtual desktop spans
     * several screens, capturing all of them and reducing the result to one
     * width shrinks the text by the ratio between desktop and monitor, which is
     * enough to leave the model unable to read a form it is looking straight at.
     * Pass 'all' only when something has opened on another screen.
     *
     * @param {'primary'|'all'} [monitor]
     * @returns {Promise<{path: string, width: number, height: number, screenWidth: number, screenHeight: number, screenX: number, screenY: number, shrink: number}>}
     */
    async screenshot(monitor = 'primary') {
        const screen = await this.measure();

        /**
         * Sized against what is about to be captured, which is not the same
         * thing as the desktop: on a multi-monitor machine the virtual desktop
         * can be several times wider than the monitor a normal capture covers,
         * and sizing against the wrong one is how a capture ends up arbitrarily
         * over- or under-reduced.
         */
        const sourceWidth = monitor === 'all' ? screen.width : screen.primary_width;

        return this.capture({monitor, maxWidth: this.captureWidthFor(sourceWidth)});
    }

    /**
     * Captures one rectangle of the screen, at native resolution where the
     * budget allows.
     *
     * This is what makes the agent independent of the screen it runs on. A
     * whole-screen capture from a large display is necessarily reduced, and
     * small print may not survive that however the ratio is tuned; a region is
     * captured without being shrunk, so text can always be read by looking
     * closer rather than by the machine happening to have a convenient
     * resolution.
     *
     * @param {{x: number, y: number, width: number, height: number}} region In screen coordinates.
     * @returns {Promise<object>}
     */
    async screenshotRegion(region) {
        await this.measure();

        return this.capture({
            region,

            // No deliberate shrink: a region is for reading, so 1:1 unless it is
            // itself larger than the budget allows.
            maxWidth: Math.min(Math.round(region.width), this.maxScreenshotWidth),
        });
    }

    /**
     * @param {{monitor?: string, region?: object, maxWidth: number}} request
     * @returns {Promise<object>}
     */
    async capture(request) {
        const file = path.join(this.workDir, `${crypto.randomBytes(8).toString('hex')}.png`);

        const shot = await this.call('screenshot', {
            path: file,
            max_width: request.maxWidth,
            monitor: request.monitor || 'primary',
            region: request.region || null,
        });

        return {
            path: shot.path,
            width: shot.width,
            height: shot.height,
            screenWidth: shot.screen_width,
            screenHeight: shot.screen_height,
            screenX: shot.screen_x,
            screenY: shot.screen_y,

            // What the model is losing, so the loop and preflight can say so
            shrink: shot.screen_width / shot.width,
        };
    }

    /**
     * Shuts the host down.
     *
     * @returns {void}
     */
    close() {
        if (!this.host) {
            return;
        }

        try {
            this.host.stdin.end();
            this.host.kill();
        } catch (error) {
            console.error(`[desktop] could not close the host: ${error.message}`);
        }

        this.host = null;
        this.ready = null;
    }
}

/**
 * A desktop bound to a scratch directory under the system temp.
 *
 * @param {string} [workDir]
 * @param {{powershell?: string, screenshotWidth?: number}} [options]
 * @returns {Desktop}
 */
function create(workDir, options) {
    return new Desktop(workDir || path.join(os.tmpdir(), 'kycdd-remote-agent', 'screens'), options);
}

export {Desktop, create};
