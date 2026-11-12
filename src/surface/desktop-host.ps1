# Direct desktop control for the remote agent.
#
# Mouse, keyboard and screen capture straight through user32 and System.Drawing,
# with no browser automation underneath. The agent drives whatever is on screen -
# a browser, a native window, a Windows file dialog, an IE-mode page - because at
# this level there is no difference between them.
#
# It runs as one long-lived process rather than being launched per action. The
# P/Invoke types are compiled once at startup by Add-Type, which takes a second
# or two; paying that on every mouse move would make a sixty-step run unusable.
# Commands arrive as one JSON object per line on stdin, and each one is answered
# with exactly one JSON object on stdout.
#
# Two conventions keep the protocol readable from Node:
#   - stdout carries protocol only. Anything diagnostic goes to stderr, so a
#     stray warning can never be parsed as a response.
#   - a screenshot is written to a file and its path returned, never inlined as
#     base64. A full-screen PNG is megabytes, and pushing that through a stdout
#     line is how the pipe deadlocks.

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace Kycdd
{
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT
    {
        public uint type;
        public INPUTUNION u;
    }

    public static class Native
    {
        const uint INPUT_MOUSE = 0;
        const uint INPUT_KEYBOARD = 1;

        const uint KEYEVENTF_KEYUP = 0x0002;
        const uint KEYEVENTF_UNICODE = 0x0004;

        [DllImport("user32.dll", SetLastError = true)]
        static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

        [DllImport("user32.dll")]
        static extern bool SetCursorPos(int x, int y);

        [DllImport("user32.dll")]
        static extern bool GetCursorPos(out POINT point);

        [DllImport("user32.dll")]
        static extern bool SetProcessDPIAware();

        // Without this, Windows lies about the screen on any display with
        // scaling turned on: the capture comes back at real pixel size while
        // cursor coordinates are reported in scaled units, so every click lands
        // short of where the model aimed. Called once at startup.
        public static void DpiAware()
        {
            try { SetProcessDPIAware(); } catch { }
        }

        public static void MoveTo(int x, int y)
        {
            SetCursorPos(x, y);
        }

        public static POINT Cursor()
        {
            POINT point;
            GetCursorPos(out point);
            return point;
        }

        // Raw mouse event. Buttons and the wheel are the same call, with flags
        // deciding which; mouseData carries the wheel delta.
        public static void Mouse(uint flags, int mouseData)
        {
            INPUT[] input = new INPUT[1];
            input[0].type = INPUT_MOUSE;
            input[0].u.mi.dwFlags = flags;
            input[0].u.mi.mouseData = unchecked((uint)mouseData);

            SendInput(1, input, Marshal.SizeOf(typeof(INPUT)));
        }

        // Types one character by its code point rather than by key code.
        //
        // This is why typing goes through SendInput and not SendKeys: the UAE
        // registers hold Arabic names, and a key-code path can only produce what
        // the current keyboard layout has keys for. KEYEVENTF_UNICODE sends the
        // character itself, so Arabic and accented Latin arrive intact whatever
        // the layout is.
        public static void KeyUnicode(char character)
        {
            INPUT[] input = new INPUT[2];

            input[0].type = INPUT_KEYBOARD;
            input[0].u.ki.wScan = character;
            input[0].u.ki.dwFlags = KEYEVENTF_UNICODE;

            input[1].type = INPUT_KEYBOARD;
            input[1].u.ki.wScan = character;
            input[1].u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;

            SendInput(2, input, Marshal.SizeOf(typeof(INPUT)));
        }

        // Presses or releases one virtual key, for the things that are keys
        // rather than characters: Tab, Enter, Escape, the modifiers.
        public static void KeyVirtual(ushort key, bool up)
        {
            INPUT[] input = new INPUT[1];
            input[0].type = INPUT_KEYBOARD;
            input[0].u.ki.wVk = key;
            input[0].u.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0;

            SendInput(1, input, Marshal.SizeOf(typeof(INPUT)));
        }
    }
}
'@

[Kycdd.Native]::DpiAware()

# user32 mouse event flags
$MOUSE = @{
    left_down   = 0x0002
    left_up     = 0x0004
    right_down  = 0x0008
    right_up    = 0x0010
    middle_down = 0x0020
    middle_up   = 0x0040
    wheel       = 0x0800
    hwheel      = 0x1000
}

# The keys the agent may name. An allow-list rather than free text, because a
# name that does not resolve should be an error the model can see and correct,
# not a silently dropped keystroke.
$KEYS = @{
    'backspace' = 0x08; 'tab' = 0x09; 'enter' = 0x0D; 'return' = 0x0D
    'shift' = 0x10; 'ctrl' = 0x11; 'control' = 0x11; 'alt' = 0x12
    'escape' = 0x1B; 'esc' = 0x1B; 'space' = 0x20
    'pageup' = 0x21; 'pagedown' = 0x22; 'end' = 0x23; 'home' = 0x24
    'left' = 0x25; 'up' = 0x26; 'right' = 0x27; 'down' = 0x28
    'insert' = 0x2D; 'delete' = 0x2E
    'win' = 0x5B; 'meta' = 0x5B
    'f1' = 0x70; 'f2' = 0x71; 'f3' = 0x72; 'f4' = 0x73; 'f5' = 0x74; 'f6' = 0x75
    'f7' = 0x76; 'f8' = 0x77; 'f9' = 0x78; 'f10' = 0x79; 'f11' = 0x7A; 'f12' = 0x7B
}

function Get-VirtualScreen {
    return [System.Windows.Forms.SystemInformation]::VirtualScreen
}

function Write-Response {
    param([hashtable] $Payload)

    # Depth matters: the default of 2 silently flattens nested objects
    [Console]::Out.WriteLine(($Payload | ConvertTo-Json -Compress -Depth 8))
    [Console]::Out.Flush()
}

function Invoke-MouseButton {
    param([string] $Button, [string] $Direction)

    $name = "{0}_{1}" -f $Button, $Direction

    if (-not $MOUSE.ContainsKey($name)) {
        throw "Unknown mouse button '$Button'."
    }

    [Kycdd.Native]::Mouse([uint32] $MOUSE[$name], 0)
}

function Invoke-Screenshot {
    param([string] $Path, [int] $MaxWidth, [string] $Monitor, [object] $Region)

    # A region if one was asked for, otherwise the primary monitor.
    #
    # On a multi-monitor machine the virtual desktop can be several times wider
    # than one screen, and everything captured gets reduced to the same width
    # before it is sent to the model. Capturing all of it therefore shrinks the
    # text by the ratio between the desktop and one monitor, which is how a
    # model ends up unable to read a form it is looking straight at. Capturing
    # one monitor keeps text readable; 'all' is for chasing a window that opened
    # on another screen; a region is for reading something too small to resolve
    # in a whole-screen capture, and is what makes this work on a screen of any
    # size.
    $bounds = if ($null -ne $Region) {
        $virtual = Get-VirtualScreen

        # Clamped to what actually exists: CopyFromScreen throws on a rectangle
        # that runs off the desktop, and a model asking for a region slightly
        # over an edge is an ordinary thing to do, not an error worth failing on.
        $x = [Math]::Max($virtual.X, [int] $Region.x)
        $y = [Math]::Max($virtual.Y, [int] $Region.y)
        $right = [Math]::Min($virtual.X + $virtual.Width, $x + [int] $Region.width)
        $bottom = [Math]::Min($virtual.Y + $virtual.Height, $y + [int] $Region.height)

        $width = $right - $x
        $height = $bottom - $y

        if ($width -lt 1 -or $height -lt 1) {
            throw 'That region does not overlap the screen.'
        }

        New-Object System.Drawing.Rectangle($x, $y, $width, $height)
    } elseif ($Monitor -eq 'all') {
        Get-VirtualScreen
    } else {
        [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    }

    $shot = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
    try {
        $graphics = [System.Drawing.Graphics]::FromImage($shot)
        try {
            $graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $shot.Size)
        }
        finally {
            $graphics.Dispose()
        }

        $width = $bounds.Width
        $height = $bounds.Height
        $image = $shot

        # Scaled down before it leaves this process. A 4K screenshot is both
        # expensive to send to a model and harder for it to read than the same
        # screen at a sane width; the caller maps coordinates back up.
        if ($MaxWidth -gt 0 -and $bounds.Width -gt $MaxWidth) {
            $scale = $MaxWidth / $bounds.Width
            $width = [int] [Math]::Round($bounds.Width * $scale)
            $height = [int] [Math]::Round($bounds.Height * $scale)

            $resized = New-Object System.Drawing.Bitmap($width, $height)
            $graphics = [System.Drawing.Graphics]::FromImage($resized)
            try {
                $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                $graphics.DrawImage($shot, 0, 0, $width, $height)
            }
            finally {
                $graphics.Dispose()
            }

            $image = $resized
        }

        try {
            $image.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
        }
        finally {
            if (-not [Object]::ReferenceEquals($image, $shot)) {
                $image.Dispose()
            }
        }
    }
    finally {
        $shot.Dispose()
    }

    return @{
        path = $Path
        width = $width
        height = $height
        screen_width = $bounds.Width
        screen_height = $bounds.Height
        screen_x = $bounds.X
        screen_y = $bounds.Y
    }
}

function Invoke-Request {
    param([object] $Request)

    switch ($Request.command) {
        'ping' {
            return @{ok = $true}
        }

        'screen_size' {
            # Both, because they are different questions. The virtual desktop is
            # what coordinates are relative to; the primary monitor is what a
            # normal capture covers, and therefore what a capture should be
            # sized against. On a multi-monitor machine these differ by a lot.
            $virtual = Get-VirtualScreen
            $primary = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds

            return @{
                ok = $true
                width = $virtual.Width
                height = $virtual.Height
                x = $virtual.X
                y = $virtual.Y
                primary_width = $primary.Width
                primary_height = $primary.Height
                primary_x = $primary.X
                primary_y = $primary.Y
                monitors = [System.Windows.Forms.Screen]::AllScreens.Count
            }
        }

        'cursor_position' {
            $point = [Kycdd.Native]::Cursor()
            return @{ok = $true; x = $point.X; y = $point.Y}
        }

        'screenshot' {
            $maxWidth = if ($null -ne $Request.max_width) { [int] $Request.max_width } else { 0 }
            $monitor = if ($Request.monitor) { [string] $Request.monitor } else { 'primary' }
            $result = Invoke-Screenshot -Path ([string] $Request.path) -MaxWidth $maxWidth -Monitor $monitor -Region $Request.region
            $result['ok'] = $true
            return $result
        }

        'mouse_move' {
            [Kycdd.Native]::MoveTo([int] $Request.x, [int] $Request.y)
            return @{ok = $true}
        }

        'mouse_click' {
            $button = if ($Request.button) { [string] $Request.button } else { 'left' }
            $count = if ($Request.count) { [int] $Request.count } else { 1 }

            if ($null -ne $Request.x -and $null -ne $Request.y) {
                [Kycdd.Native]::MoveTo([int] $Request.x, [int] $Request.y)
                Start-Sleep -Milliseconds 20
            }

            for ($i = 0; $i -lt $count; $i++) {
                Invoke-MouseButton -Button $button -Direction 'down'
                Start-Sleep -Milliseconds 15
                Invoke-MouseButton -Button $button -Direction 'up'

                if ($i -lt ($count - 1)) {
                    # Inside the double-click interval Windows expects
                    Start-Sleep -Milliseconds 90
                }
            }

            return @{ok = $true}
        }

        'mouse_drag' {
            $button = if ($Request.button) { [string] $Request.button } else { 'left' }

            [Kycdd.Native]::MoveTo([int] $Request.from_x, [int] $Request.from_y)
            Start-Sleep -Milliseconds 40
            Invoke-MouseButton -Button $button -Direction 'down'

            # Moved in steps, because a single jump to the destination reads as a
            # teleport and many drag handlers simply ignore it
            $steps = 12
            $dx = ([int] $Request.to_x - [int] $Request.from_x) / $steps
            $dy = ([int] $Request.to_y - [int] $Request.from_y) / $steps

            for ($i = 1; $i -le $steps; $i++) {
                $x = [int] [Math]::Round([int] $Request.from_x + ($dx * $i))
                $y = [int] [Math]::Round([int] $Request.from_y + ($dy * $i))
                [Kycdd.Native]::MoveTo($x, $y)
                Start-Sleep -Milliseconds 15
            }

            Start-Sleep -Milliseconds 40
            Invoke-MouseButton -Button $button -Direction 'up'

            return @{ok = $true}
        }

        'scroll' {
            if ($null -ne $Request.x -and $null -ne $Request.y) {
                [Kycdd.Native]::MoveTo([int] $Request.x, [int] $Request.y)
                Start-Sleep -Milliseconds 20
            }

            # One notch is 120, and the sign is the direction
            $clicks = if ($null -ne $Request.clicks) { [int] $Request.clicks } else { 3 }
            $flag = if ($Request.horizontal) { $MOUSE['hwheel'] } else { $MOUSE['wheel'] }
            $delta = 120 * $clicks

            [Kycdd.Native]::Mouse([uint32] $flag, $delta)

            return @{ok = $true}
        }

        'type_text' {
            $text = [string] $Request.text

            foreach ($character in $text.ToCharArray()) {
                [Kycdd.Native]::KeyUnicode($character)
                Start-Sleep -Milliseconds 12
            }

            return @{ok = $true; characters = $text.Length}
        }

        'press_keys' {
            # A chord: everything is held in order then released in reverse, so
            # ["ctrl","a"] is ctrl+a rather than two separate keystrokes
            $names = @($Request.keys)
            $codes = @()

            foreach ($name in $names) {
                $key = ([string] $name).ToLowerInvariant()

                if (-not $KEYS.ContainsKey($key)) {
                    throw "Unknown key '$name'."
                }

                $codes += [uint16] $KEYS[$key]
            }

            foreach ($code in $codes) {
                [Kycdd.Native]::KeyVirtual($code, $false)
                Start-Sleep -Milliseconds 15
            }

            for ($i = $codes.Count - 1; $i -ge 0; $i--) {
                [Kycdd.Native]::KeyVirtual($codes[$i], $true)
                Start-Sleep -Milliseconds 15
            }

            return @{ok = $true}
        }

        default {
            throw "Unknown command '$($Request.command)'."
        }
    }
}

[Console]::Error.WriteLine('[desktop-host] ready')

while ($null -ne ($line = [Console]::In.ReadLine())) {
    if ([string]::IsNullOrWhiteSpace($line)) {
        continue
    }

    $id = $null

    try {
        $request = $line | ConvertFrom-Json
        $id = $request.id

        $response = Invoke-Request -Request $request
        $response['id'] = $id

        Write-Response -Payload $response
    }
    catch {
        # Answered rather than thrown, so one bad command cannot take the host
        # down and strand the run that was using it
        Write-Response -Payload @{
            id = $id
            ok = $false
            error = $_.Exception.Message
        }
    }
}
