# Deploying on a Windows machine

How to run this agent on the Windows machine that holds the live session. The
architecture — one loop over a browser or a desktop surface — is in the root
`README.md`; this is the operational guide.

It exists because some services — UAE Pass sign-in on Growth, and the older
emirate portals behind it — refuse everything except a genuine interactive
session. KYCDD posts a task; the agent works the portal while reading the screen,
and posts back a structured result.

**The agent does not run on the machine it is developed on.** Copy the whole
`kycdd-remote-desktop-control` folder to the Windows machine. The **desktop**
surface needs only Node and the in-box Windows PowerShell — no `npm install`. The
**browser** surface additionally needs Puppeteer (`npm install`, which pulls the
optional dependencies). Choose the surface with `REMOTE_AGENT_SURFACE`. Run the
commands below from the folder root.

The interactive-desktop requirements below apply to **both** surfaces: a real
browser and direct desktop control each need a visible, unlocked session. They
matter most for the desktop surface, which captures and drives the screen itself.

---

## Requirements

| Requirement | Why | Notes |
|---|---|---|
| **Windows 10 / 11, or Server 2016+** | Desktop control goes through `user32` (`SendInput`, `SetCursorPos`) and `System.Drawing` screen capture. | Not portable to Linux or macOS. |
| **Node.js 20 LTS or newer** | The model client uses global `fetch`. | 18 works but warns on every start (`fetch` was experimental until 21) and lacks `AbortSignal.any`, for which there is a fallback. |
| **Windows PowerShell 5.1** | Hosts the mouse, keyboard and capture code. | Already installed on every supported Windows build — nothing to download. See *PowerShell 7* below. |
| **An interactive desktop session** | `SendInput` and screen capture only work against a real, visible desktop. | This is the constraint people trip over. See *Deployment* below. |
| **A browser** | Whatever the portals need. Install and sign in to it once by hand. | The agent drives whatever is on screen; it does not install or manage a browser. |
| **Outbound HTTPS** | To the model provider, and to the portals themselves. | Inbound only from KYCDD, see *Network*. |

### What it does *not* need

Worth stating, because each of these is a thing you might reasonably expect to
have to install:

- **No `npm install` for the desktop surface.** It has zero runtime
  dependencies; every import is a Node built-in or a file under `src/`. Puppeteer
  and dotenv are *optional* dependencies (see `package.json`), loaded only by the
  browser surface and the local `run-task` CLI, so a desktop-only machine never
  pulls them in.
- **No native modules, no compiler, no build step.** Nothing to rebuild when Node
  is upgraded, which is the usual reason a desktop-automation box rots.
- **No Puppeteer, Playwright, Selenium or WebDriver.** The agent controls the
  machine, not a browser, so there is no driver to keep matched to a browser
  version.
- **No administrator rights**, unless you choose to expose the port through the
  firewall.
- **No Python, .NET SDK, or Visual Studio build tools.** The PowerShell host
  compiles its own P/Invoke types at startup using the compiler already in
  Windows PowerShell.
- **No particular screen resolution.** The agent measures the display it finds
  and sizes itself from that, and reads small text by zooming into a region. See
  *Display*.

---

## Installation

### 1. Copy the folder to the Windows machine

Copy the whole `kycdd-remote-desktop-control` folder anywhere it can stay put,
for example `C:\kycdd-remote-desktop-control`. Run every command below from that
folder.

### 2. Install Node.js

Download the current LTS from <https://nodejs.org/> and install it, or:

```powershell
winget install OpenJS.NodeJS.LTS
```

Then confirm, in a **new** terminal:

```powershell
node --version
```

### 3. Install and prepare the browser

Install whichever browser the portals need, open it by hand, and complete any
first-run prompts. Leaving a signed-in session open is fine and often desirable —
the Growth playbook explicitly checks for an existing session before signing in
again, because a second UAE Pass sign-in invalidates the first.

### 4. Configure the environment

Set the variables in *Configuration* below. The desktop agent reads real
environment variables only. The root `.env` / `.env.example` belongs to the
browser agent (`bin/run-task.js`), and the server does not read it. For a
machine-wide, persistent setting (replace the values):

```powershell
[Environment]::SetEnvironmentVariable('REMOTE_AGENT_TOKEN', 'the-shared-token', 'Machine')
[Environment]::SetEnvironmentVariable('REMOTE_AGENT_SECRET', 'the-shared-secret', 'Machine')
[Environment]::SetEnvironmentVariable('OPENAI_API_KEY', 'sk-...', 'Machine')
[Environment]::SetEnvironmentVariable('REMOTE_AGENT_MODEL', 'the-model-to-use', 'Machine')
```

`REMOTE_AGENT_TOKEN` and `REMOTE_AGENT_SECRET` must match
`remote_browser_agent_token` and `remote_browser_agent_secret` in the KYCDD
`.env`. They are two separate values on purpose: the token says which caller this
is, the secret proves a request was not tampered with or replayed. Rotate them
independently.

### 5. Check the machine

```powershell
npm run preflight
```

This verifies Node, PowerShell, the capture assemblies, that the desktop is
really visible, that the screen is not being shrunk past readability, and that
the configuration is present. It is read-only — it does not move the mouse or
call the model provider. Fix anything it reports as `FAIL`, and read the
`warn` lines.

### 6. Start it

```powershell
npm run serve
```

It refuses to start if a required variable is missing, rather than starting and
looking healthy while being unable to work.

### 7. Verify from the KYCDD side

Point `remote_browser_agent_url` at the machine (`http://<host>:8787`) and
trigger a Growth verification with no valid cookie. The run should appear in the
agent's log as `POST /tasks 202`, and the step log should come back on the KYCDD
side. `GET /health` needs no authentication and is there for whatever watches the
process.

---

## Configuration

### Required

| Variable | Purpose |
|---|---|
| `REMOTE_AGENT_TOKEN` | Shared with KYCDD as `remote_browser_agent_token`. |
| `REMOTE_AGENT_SECRET` | Shared with KYCDD as `remote_browser_agent_secret`. Signs every request. |
| `OPENAI_API_KEY` | Model provider key. Same variable name the PHP side uses, so one value serves both. |
| `REMOTE_AGENT_MODEL` | Which model to use. **There is deliberately no default** — a default in source is how a machine ends up quietly running something nobody chose. |

### Optional

| Variable | Default | Purpose |
|---|---|---|
| `REMOTE_AGENT_HOST` | `127.0.0.1` | Interface to bind. Loopback until you deliberately change it. |
| `REMOTE_AGENT_PORT` | `8787` | Port to listen on. |
| `REMOTE_AGENT_MAX_SHRINK` | `1.5` | How much a whole-screen view may be reduced before the model sees it. The capture width is derived from this and the screen the machine turns out to have — see *Display*. |
| `REMOTE_AGENT_MAX_SCREENSHOT_WIDTH` | `1920` | Ceiling on capture width, bounding tokens per step on a large display. |
| `REMOTE_AGENT_SCREENSHOT_WIDTH` | *(unset)* | Pins the capture width, overriding the two above. Not normally needed. |
| `REMOTE_AGENT_SCREENSHOT_HISTORY` | `3` | How many recent screenshots stay in the conversation. Images dominate the cost of a long run. |
| `REMOTE_AGENT_POWERSHELL` | `powershell.exe` | Full path, if the bare name does not resolve. |
| `REMOTE_AGENT_MODEL_TIMEOUT_SECONDS` | `180` | Per model call. |
| `REMOTE_AGENT_API_BASE_URL` | `https://api.openai.com/v1` | Point at a gateway or proxy. |
| `REMOTE_AGENT_REASONING_EFFORT` | unset | Passed through when set; otherwise the provider's default. |
| `REMOTE_AGENT_STORE_CONVERSATION` | `0` | `1` lets the provider retain the conversation. Off by default: these runs carry portal screens and, for Growth, a harvested session cookie. |
| `REMOTE_AGENT_ARTIFACT_DIR` | under `%TEMP%` | Where screenshots and documents are written. |
| `REMOTE_AGENT_JOB_RETENTION_SECONDS` | `1800` | How long a finished job is kept before it and its artifacts are purged. Short on purpose. |
| `REMOTE_AGENT_IDEMPOTENCY_WINDOW_SECONDS` | `600` | How long a repeat dispatch collapses onto the existing job. |
| `REMOTE_AGENT_CLOCK_SKEW_SECONDS` | `300` | Tolerated clock difference with KYCDD. |
| `REMOTE_AGENT_MAX_QUEUE_DEPTH` | `8` | Tasks allowed to wait. Runs execute one at a time. |
| `REMOTE_AGENT_MAX_BODY_BYTES` | `1048576` | Largest accepted request body. |

### Portal credentials

A task never carries a secret. It names an alias, and this machine resolves it:

```powershell
[Environment]::SetEnvironmentVariable('REMOTE_AGENT_CRED_GROWTH_UAE_PASS_USERNAME', 'someone@example.com', 'Machine')
[Environment]::SetEnvironmentVariable('REMOTE_AGENT_CRED_GROWTH_UAE_PASS_PASSWORD', '...', 'Machine')
```

The alias `growth_uae_pass` becomes `REMOTE_AGENT_CRED_GROWTH_UAE_PASS_*`
(uppercased). The model is told a credential exists and given a tool that types
it; it is never shown the value, so it cannot repeat it into its notes, a
screenshot caption, or the result. Rotating a portal password is done here, with
no KYCDD deploy.

### One-time codes

When a portal asks for a code, the agent waits for a file to appear:

```
%TEMP%\kycdd-remote-agent\artifacts\work\2fa.txt
```

Write the code into it and the agent types it and deletes the file. This is the
same mechanism the existing KYCDD scrapers use (`get2faCodeFromFile` in
`puppeteer/Handler.js` in the KYCDD repository). The default wait is three minutes.

If sign-in requires approval in the **UAE Pass mobile app** rather than a code,
no file will help: either somebody taps approve while the run waits, or the
machine approves it on an Android emulator. The emulator route is opt-in — set
`REMOTE_AGENT_UAE_PASS_APPROVAL=auto` and point `REMOTE_AGENT_EMULATOR_SERIAL` at
an emulator enrolled with the account. It is off by default because it removes
the human from the approval, and it is **unverified against the real app** — see
`src/twofactor/UaePassApp.js` and the root `README.md` section on two-factor.

---

## Deployment

### The interactive-session requirement

The agent must run in a logged-in, visible desktop session. This is not a
preference:

- **It cannot run as a Windows service.** Services run in session 0, which has no
  desktop; `SendInput` goes nowhere and capture returns black.
- **The screen must not be locked.** A locked desktop captures as black, so the
  model is looking at nothing.
- **Disconnecting RDP locks the session.** Use the physical console, a VM console
  that stays open, or a tool that keeps the session alive. `preflight.js` catches
  this: a near-empty screenshot is reported as a failure.
- **Nobody should use the machine while a run is in progress.** The agent drives
  the real pointer and keyboard, so a person moving the mouse or typing is
  competing with it for the same input — the agent clicks where it aimed a moment
  ago and lands somewhere else. This is why the agent wants a dedicated machine
  or VM rather than a corner of somebody's desktop.

To start it automatically, use Task Scheduler with **"Run only when user is
logged on"** — not "Run whether user is logged on or not", which is the service
case above. The Startup folder works too.

### Network

It binds to loopback by default, because this machine holds live portal
credentials and will drive a credentialed browser for anything that can reach the
port. To let KYCDD reach it, prefer a VPN or an SSH/Cloudflare tunnel over
opening a firewall port. If you do bind to a LAN interface, restrict the source
to the KYCDD servers.

Requests are signed, so an attacker who can reach the port still cannot dispatch
work without the secret — but that is a second line of defence, not a reason to
expose it.

### Display

**There is no screen size to configure.** The agent measures the display it finds
and sizes its captures from that, so the same build works on a 1366×768 laptop or
a 4K workstation without being told which it is.

How it works, in case you need to tune it:

- A whole-screen view is reduced by at most `REMOTE_AGENT_MAX_SHRINK` (1.5×),
  which is comfortable for portal text. On a 1920-wide screen that is a 1280px
  capture; on 2560 it is 1707.
- It is never reduced below 1024px, and never scaled up — a small screen is
  captured at or near its own size.
- It is never larger than `REMOTE_AGENT_MAX_SCREENSHOT_WIDTH` (1920), because
  cost grows with image area. A 4K screen is therefore reduced 2×, past the
  comfort target.
- Which is fine, because the model can **look closer**: it can ask for any
  rectangle of the screen and get it back at full size. That is what makes an
  unknown screen size workable — small print is read by zooming, not by the
  machine happening to have a convenient resolution. The model is instructed to
  do that rather than guess at anything it cannot resolve.

So the only reason to touch these is cost or speed. If runs on a high-resolution
machine take too many steps zooming, raise `REMOTE_AGENT_MAX_SCREENSHOT_WIDTH`
(more tokens per step, fewer steps) or lower the display resolution.
`preflight.js` reports the ratio it arrived at and checks that region captures
really do come back at full size.

Display scaling is handled — the host marks itself DPI-aware, so clicks land
where the model aimed on a scaled display.

Multiple monitors work. The agent captures the **primary** screen, and sizes that
capture against the primary monitor rather than the whole desktop, so a second
monitor does not degrade the view. A window that opens on another screen is found
by capturing `all` and then zooming into it. A single-monitor machine is still
simpler.

### PowerShell 7

The host is launched with `powershell.exe` — the Windows PowerShell 5.1 built
into Windows — because it always has `System.Windows.Forms` and `System.Drawing`.
PowerShell 7 (`pwsh`) works on Windows builds with the Desktop runtime, but gains
nothing here. Only set `REMOTE_AGENT_POWERSHELL` if the default does not resolve.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Exits at startup naming a variable | That variable is not set. Deliberate: see *Required*. |
| Every request gets `401` | Token or secret does not match KYCDD, or the clocks differ by more than `REMOTE_AGENT_CLOCK_SKEW_SECONDS`. The agent's log says which. |
| `preflight.js`: screenshot essentially blank | No interactive desktop — locked screen, disconnected RDP, or running as a service. |
| Runs fail with `credentials_missing` | No `REMOTE_AGENT_CRED_<ALIAS>_*` for the service's alias. |
| The model clicks slightly wrong, consistently | Check `preflight.js`: a region capture that comes back reduced, or a display whose scaling is not being reported, both show up there. |
| Runs spend many steps zooming in | A high-resolution display reduced past the comfort target. Raise `REMOTE_AGENT_MAX_SCREENSHOT_WIDTH` or lower the resolution — see *Display*. |
| Host fails to start, mentions execution policy | A machine policy of `AllSigned`/`Restricted` overrides `-ExecutionPolicy Bypass`. |
| Dispatches answered `429` | A run is already in progress and the queue is full. Runs are serialised because the portals share one login. |
| Growth runs end without the session values | Run it on the **browser** surface, not the desktop one. See *Choosing a surface*. |

---

## Choosing a surface

Set `REMOTE_AGENT_SURFACE` to `browser` or `desktop`.

The **desktop** surface drives the machine by mouse, keyboard and screenshots,
which is everything needed for a portal whose answers are on screen. It is **not**
enough for the Growth session harvest: four of the values that task collects live
in the `versionInfo` object of POST request *bodies*, and another is an
`X-CSRFToken` request *header*. None of that is ever drawn on screen, so no amount
of looking finds it.

Those values come from the browser's own network log, which only the **browser**
surface can read: `src/surface/NetworkLog.js` records the requests over CDP, and
`src/extractors/growthSession.js` reads the Growth values out of them when the
model calls `capture`. So route the Growth session harvest (and anything else
that needs `capture` or an origin allowlist) to the browser surface, and use the
desktop surface for portals that refuse an automated browser or need native
dialogs.

---

## What is in here

The code is under `src/` (see the layout table in the root `README.md`). Where a
value lands in a run, and the pieces this guide refers to:

| Path | |
|---|---|
| `src/server/server.js` | The HTTP endpoint KYCDD talks to. Start with `npm run serve`. |
| `src/server/signature.js` | Bearer token and HMAC verification, replay protection. |
| `src/server/jobs.js` | Job store and the queue. Runs execute one at a time. |
| `src/Agent.js` | The one loop: look, decide, act, look again. |
| `src/surface/desktopHost.js` + `desktop-host.ps1` | Desktop control: `user32` mouse and keyboard, screen capture. |
| `src/surface/BrowserSurface.js` | The browser surface and its network log. |
| `src/twofactor/` | One-time codes, and UAE Pass app approval on an emulator. |
| `src/config.js` | Every setting, read from the environment. |
| `src/preflight.js` | Checks a machine can drive the desktop surface (`npm run preflight`). |

The KYCDD side of the contract is `app/RemoteBrowser/` in the platform
repository; `RemoteAgent.php` there is the specification for the routes and the
signing scheme, and the two must change together.
