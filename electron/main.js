/***
    ---------------------------------------------------------------------------

    Copyright (c) 2026 Space Cargo Unlimited S.A.S.

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

            http://www.apache.org/licenses/LICENSE-2.0

    This file is part of the openvocs project. https://openvocs.org

    ---------------------------------------------------------------------------

    Electron shell for the openvocs web front-end. The interface is always
    loaded from the configured server (https://<server>/app/vocs/), nothing
    of src/HTML is packaged with the app.

    Gamepad push-to-talk is handled by the front-end (Gamepad API); the
    window is kept "visible" to Chromium so it keeps polling the gamepad while
    the app is unfocused, occluded or minimized. Keyboard PTT only works while
    the app is focused.
*/

const {
    app, BrowserWindow, Menu, ipcMain, session, shell, systemPreferences
} = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ENTRY_PATH = "/app/vocs/";
const ADMIN_PATH = "/app/vocs_admin/";
const LOADER_FILE = path.join(__dirname, "loader", "loader.html");
const LOADER_URL = pathToFileURL(LOADER_FILE).href;
const MAX_RETRY_DELAY = 15; // seconds
const PROBE_TIMEOUT = 20;   // seconds

const SETTINGS_FILE = path.join(app.getPath("userData"), "settings.json");

const DEFAULT_SETTINGS = {
    server: "",                     // host[:port], e.g. "openvocs.example.org"
    bounds: { width: 1280, height: 800 }
};

const GRANTED_PERMISSIONS = new Set([
    "media", "fullscreen", "notifications", "clipboard-sanitized-write",
    "speaker-selection", "keyboardLock", "pointerLock"
]);

// keep the renderer (and its Gamepad API polling) running when the window is
// covered by other windows; backgroundThrottling covers unfocused/minimized
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

let settings = load_settings();
let main_window;
let settings_window;
let admin_window;
let admin_server; // server displayed in admin_window
let retry_timer;
let retry_count = 0;
let waiting_since;
let probe; // AbortController of the server probe in flight

// settings -------------------------------------------------------------------

function load_settings() {
    try {
        let stored = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
        let known = Object.keys(DEFAULT_SETTINGS).filter(key => key in stored);
        // drop settings of earlier versions (e.g. allowInvalidCertificates)
        return { ...DEFAULT_SETTINGS, ...Object.fromEntries(known.map(key => [key, stored[key]])) };
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

function save_settings() {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 4));
}

// "https://Host:443/path" -> "host", as the browser reports URL hosts
function normalize_server(value) {
    let host = String(value || "").trim()
        .replace(/^(wss?|https?):\/\//i, "")
        .replace(/\/.*$/, "");
    try {
        return host ? new URL("https://" + host).host : "";
    } catch {
        return "";
    }
}

function entry_url() {
    return "https://" + settings.server + ENTRY_PATH;
}

function admin_url(server = settings.server) {
    return "https://" + server + ADMIN_PATH;
}

function is_trusted_url(url, server = settings.server) {
    try {
        let parsed = new URL(url);
        return parsed.protocol === "https:" &&
            parsed.host === server;
    } catch {
        return false;
    }
}

// session --------------------------------------------------------------------

function setup_session() {
    let ses = session.defaultSession;

    ses.setPermissionRequestHandler((web_contents, permission, callback, details) => {
        callback(GRANTED_PERMISSIONS.has(permission) &&
            is_trusted_url(details.requestingUrl || web_contents.getURL()));
    });

    ses.setPermissionCheckHandler((web_contents, permission, requesting_origin) => {
        return GRANTED_PERMISSIONS.has(permission) && is_trusted_url(requesting_origin);
    });
}

// windows --------------------------------------------------------------------

// pages of the window's server stay in the app, everything else opens in the
// system browser
function restrict_navigation(contents, server_of = () => settings.server) {
    contents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/.test(url))
            shell.openExternal(url);
        return { action: "deny" };
    });

    contents.on("will-navigate", (event, url) => {
        if (!is_trusted_url(url, server_of())) {
            event.preventDefault();
            if (/^https?:/.test(url))
                shell.openExternal(url);
        }
    });
}

function create_main_window() {
    main_window = new BrowserWindow({
        ...settings.bounds,
        minWidth: 400,
        minHeight: 400,
        title: "openvocs",
        backgroundColor: "#1e1e1e",
        icon: path.join(__dirname, "build", "icon.png"),
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            backgroundThrottling: false // keep audio, signaling and gamepad PTT alive when hidden
        }
    });

    restrict_navigation(main_window.webContents);

    main_window.webContents.on("will-navigate", (event, url) => {
        if (url === "openvocs:retry") // loader buttons
            load_front_end();
        else if (url === "openvocs:settings")
            open_settings_window();
    });

    // the interface failed to load although the probe succeeded (server went
    // away in between): back to the loader once the error page has committed
    main_window.webContents.on("did-fail-load", (event, code, description, url, is_main_frame) => {
        if (is_main_frame && code !== -3 && is_trusted_url(url)) // -3: aborted
            setImmediate(() => schedule_retry(describe_error(description)));
    });

    main_window.on("close", () => {
        settings.bounds = main_window.getBounds();
        save_settings();
    });

    main_window.on("closed", () => { main_window = undefined; });

    load_front_end();
}

// The loader stays on screen while the server is probed; the window only
// navigates to the interface once the server answers, so failed attempts never
// replace the loader with an error page.
async function load_front_end() {
    if (!main_window)
        return;
    clearTimeout(retry_timer);
    probe?.abort();
    if (!settings.server) {
        await show_loader();
        open_settings_window();
        return;
    }
    waiting_since ??= Date.now();
    await show_loader({ state: "connecting" });

    let controller = probe = new AbortController();
    try {
        // GET, not HEAD: ov_webserver does not map HEAD "<dir>/" to index.html
        // and drops the connection; only the headers are awaited
        let response = await session.defaultSession.fetch(entry_url(), {
            cache: "no-store",
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(PROBE_TIMEOUT * 1000)])
        });
        response.body?.cancel().catch(() => { });
        if (response.status >= 500) // e.g. reverse proxy up, openvocs not yet
            throw new Error("HTTP " + response.status + " " + response.statusText);
    } catch (error) {
        if (!controller.signal.aborted)
            schedule_retry(describe_error(error));
        return;
    } finally {
        if (probe === controller)
            probe = undefined;
    }
    if (controller.signal.aborted || !main_window)
        return;
    retry_count = 0;
    waiting_since = undefined;
    main_window.loadURL(entry_url()).catch(() => { }); // failures: did-fail-load
}

function schedule_retry(error) {
    if (!main_window)
        return;
    clearTimeout(retry_timer);
    let delay = Math.min(2 ** retry_count, MAX_RETRY_DELAY);
    retry_count++;
    waiting_since ??= Date.now();
    show_loader({ state: "retrying", error, retry: delay });
    retry_timer = setTimeout(load_front_end, delay * 1000);
}

function describe_error(error) {
    if (error?.name === "TimeoutError")
        return "No answer after " + PROBE_TIMEOUT + " s";
    return String(error?.message ?? error).replace(/^net::/, "");
}

// updates the loader in place, or loads it when another page is displayed
function show_loader(status = {}) {
    let contents = main_window.webContents;
    status = {
        server: settings.server,
        attempt: retry_count + 1,
        since: waiting_since ?? Date.now(),
        ...status
    };
    if (contents.getURL().split("?")[0] === LOADER_URL && !contents.isLoading())
        return contents.executeJavaScript("update_loader(" + JSON.stringify(status) + ")")
            .catch(() => { });
    return main_window.loadFile(LOADER_FILE, { query: { status: JSON.stringify(status) } })
        .catch(() => { });
}

// the admin interface gets its own window so the voice session in the main
// window keeps running
function open_admin_window(server = settings.server, focus = true) {
    if (!server)
        return;
    admin_server = server;
    if (admin_window) {
        admin_window.loadURL(admin_url(server)).catch(() => { });
        if (focus)
            admin_window.focus();
        return;
    }
    admin_window = new BrowserWindow({
        width: 1280,
        height: 800,
        title: "openvocs admin",
        backgroundColor: "#1e1e1e",
        icon: path.join(__dirname, "build", "icon.png"),
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });
    restrict_navigation(admin_window.webContents, () => admin_server);
    admin_window.on("closed", () => { admin_window = undefined; });
    admin_window.loadURL(admin_url(server)).catch(() => { });
}

function open_settings_window() {
    if (settings_window) {
        settings_window.focus();
        return;
    }
    settings_window = new BrowserWindow({
        width: 520,
        height: 370,
        resizable: false,
        minimizable: false,
        parent: main_window,
        modal: process.platform !== "darwin" && !!main_window,
        title: "Server Settings",
        webPreferences: {
            preload: path.join(__dirname, "settings", "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });
    settings_window.setMenuBarVisibility(false);
    settings_window.loadFile(path.join(__dirname, "settings", "settings.html"));
    settings_window.on("closed", () => { settings_window = undefined; });
}

ipcMain.handle("settings:get", () => {
    let { bounds, ...editable } = settings;
    return editable;
});

// admin URL for the address typed in the settings window (saved or not)
ipcMain.handle("admin:url", (event, value) => {
    let server = normalize_server(value);
    return server ? admin_url(server) : "";
});

ipcMain.handle("settings:save", (event, values) => {
    let server = normalize_server(values.server);
    if (!server)
        throw new Error(String(values.server || "").trim()
            ? "Invalid server address." : "A server address is required.");
    settings = {
        ...settings,
        server
    };
    save_settings();
    if (admin_window && admin_server !== server)
        open_admin_window(server, false); // follow the new server
    retry_count = 0;
    waiting_since = undefined;
    if (settings_window)
        settings_window.close();
    load_front_end();
});

ipcMain.handle("admin:open", (event, value) => {
    let server = normalize_server(value) || settings.server;
    if (settings_window)
        settings_window.close();
    open_admin_window(server);
});

ipcMain.handle("settings:cancel", () => {
    if (settings_window)
        settings_window.close();
});

// menu -----------------------------------------------------------------------

function build_menu() {
    let is_mac = process.platform === "darwin";
    let settings_item = {
        label: "Server Settings…",
        accelerator: "CmdOrCtrl+,",
        click: open_settings_window
    };
    let template = [
        ...(is_mac ? [{
            label: app.name,
            submenu: [
                { role: "about" }, { type: "separator" },
                settings_item, { type: "separator" },
                { role: "hide" }, { role: "hideOthers" }, { role: "unhide" },
                { type: "separator" }, { role: "quit" }
            ]
        }] : [{
            label: "File",
            submenu: [settings_item, { type: "separator" }, { role: "quit" }]
        }]),
        { role: "editMenu" },
        {
            label: "View",
            submenu: [
                { label: "Reload", accelerator: "CmdOrCtrl+R", click: load_front_end },
                { role: "toggleDevTools" },
                { type: "separator" },
                { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
                { type: "separator" },
                { role: "togglefullscreen" }
            ]
        },
        { role: "windowMenu" }
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// lifecycle ------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on("second-instance", () => {
        if (main_window) {
            if (main_window.isMinimized())
                main_window.restore();
            main_window.focus();
        }
    });

    // Windows: groups the taskbar entry and labels notifications as openvocs
    if (process.platform === "win32")
        app.setAppUserModelId("com.space-cu.openvocs");

    app.whenReady().then(async () => {
        setup_session();
        build_menu();

        if (process.platform === "darwin" &&
            systemPreferences.getMediaAccessStatus("microphone") !== "granted")
            await systemPreferences.askForMediaAccess("microphone");

        create_main_window();

        app.on("activate", () => {
            if (BrowserWindow.getAllWindows().length === 0)
                create_main_window();
        });
    });

    app.on("window-all-closed", () => {
        if (process.platform !== "darwin")
            app.quit();
    });
}
