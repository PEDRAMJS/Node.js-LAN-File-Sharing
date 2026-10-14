"use strict";

/* Admin panel. Only served to localhost, see lib/admin.js. */

const CONFIG_LABELS = {
    allowDeletion: ["Anyone can delete any file", "Shows a delete button on every file for everyone."],
    multiUpload: ["Allow multiple files per upload", ""],
    folderUpload: ["Allow folder uploads", ""],
    trustProxy: ["Behind a reverse proxy", "Use X-Forwarded-For as the client IP for bans. Only turn on behind a proxy you control."],
    maxFileSize: ["Max upload size (bytes)", ""],
    maxAutoDeleteMinutes: ["Longest auto-delete time (minutes)", ""],
    ownershipTtlMinutes: ["Uploader can delete own upload for (minutes)", "Also ends when they refresh the page."],
    banThreshold: ["Failed password attempts before a ban", ""],
    banHours: ["Ban length (hours)", ""],
    minPasswordLength: ["Minimum length of chosen file passwords", ""]
};

let csrfToken = null;

function $(id) { return document.getElementById(id); }

function show(element, visible) { element.classList.toggle("hidden", !visible); }

function showError(message) {
    const element = $("globalError");
    element.textContent = message || "";
    show(element, !!message);
}

let toastTimeout = null;
function toast(message) {
    const element = $("toast");
    element.textContent = message;
    show(element, true);
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => show(element, false), 2500);
}

async function api(method, url, body) {
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
    const response = await fetch("api/" + url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        credentials: "same-origin"
    });
    let data = null;
    try {
        data = await response.json();
    } catch (error) {
        // NOTE: Some errors have no JSON body.
    }
    if (response.status == 401 && url != "login" && url != "rotate") {
        csrfToken = null;
        await refreshStatus();
    }
    if (!response.ok) throw new Error((data && data.error) || `Request failed (${response.status})`);
    return data;
}

function formatTime(epochMs) {
    return epochMs == null ? "" : new Date(epochMs).toLocaleString();
}

function element(tag, attributes, children) {
    const node = document.createElement(tag);
    Object.keys(attributes || {}).forEach((key) => {
        if (key == "text") node.textContent = attributes[key];
        else if (key.startsWith("on")) node.addEventListener(key.slice(2), attributes[key]);
        else node.setAttribute(key, attributes[key]);
    });
    (children || []).forEach((child) => node.appendChild(child));
    return node;
}

function table(headers, rows, emptyText) {
    if (rows.length == 0) return element("p", { class: "hint", text: emptyText });
    return element("div", { class: "table-wrap" }, [
        element("table", {}, [
            element("thead", {}, [element("tr", {}, headers.map((header) => element("th", { text: header })))]),
            element("tbody", {}, rows.map((cells) => element("tr", {}, cells.map((cell) =>
                element("td", {}, [typeof cell == "string" ? document.createTextNode(cell) : cell])))))
        ])
    ]);
}

/* Views */

function applyStatus(status) {
    csrfToken = status.csrf;
    document.querySelectorAll(".min-secret-length").forEach((node) => { node.textContent = status.minSecretLength; });
    show($("debugWarning"), status.debugPrintPasswords);

    const badge = $("stateBadge");
    badge.textContent = { new: "Not set up", locked: "Locked", unlocked: "Unlocked" }[status.state];
    badge.className = "state-badge state-" + status.state;

    show($("setupView"), status.state == "new");
    show($("loginView"), status.state != "new" && !status.loggedIn);
    show($("panelView"), status.loggedIn);
    show($("logoutButton"), status.loggedIn);

    if (status.state == "locked") {
        $("loginTitle").textContent = "Unlock the server";
        $("loginText").textContent = "The server is locked. Everyone else sees a \"locked\" page until you enter the secret key.";
        $("loginButton").textContent = "Unlock";
    } else {
        $("loginTitle").textContent = "Log in";
        $("loginText").textContent = "The server is running. Enter the secret key to change settings.";
        $("loginButton").textContent = "Log in";
    }

    renderTls(status.tls);
    if (status.loggedIn) {
        loadConfig();
        loadBans();
        loadFiles();
    }
}

async function refreshStatus() {
    const response = await fetch("api/status", { credentials: "same-origin" });
    if (!response.ok) {
        showError(await response.text());
        return;
    }
    applyStatus(await response.json());
}

function renderTls(tls) {
    const container = $("tlsInfo");
    container.textContent = "";
    if (tls == null) {
        container.appendChild(element("p", { class: "banner banner-warning", text:
            "HTTPS is off. Passwords travel over the network unencrypted. Start the server with --https to turn it on." }));
        return;
    }
    container.appendChild(element("p", { text: tls.selfSigned ?
        "HTTPS is on with a self-signed certificate. Browsers will show a warning, users can compare this fingerprint:" :
        "HTTPS is on with your certificate. SHA-256 fingerprint:" }));
    container.appendChild(element("code", { class: "fingerprint", text: tls.fingerprint }));
}

async function loadConfig() {
    const { config, schema } = await api("GET", "config");
    const form = $("configForm");
    form.textContent = "";
    Object.keys(schema).forEach((key) => {
        const [label, hint] = CONFIG_LABELS[key] || [key, ""];
        const rule = schema[key];
        let input;
        if (rule == "boolean") {
            input = element("input", { type: "checkbox", name: key });
            input.checked = config[key];
            form.appendChild(element("label", { class: "config-row config-checkbox" }, [
                input, element("span", {}, [
                    document.createTextNode(label),
                    hint ? element("small", { text: hint }) : document.createTextNode("")
                ])
            ]));
        } else {
            input = element("input", { type: "number", name: key, min: String(rule[0]), max: String(rule[1]), step: "1" });
            input.value = config[key];
            form.appendChild(element("label", { class: "config-row" }, [
                element("span", {}, [
                    document.createTextNode(label),
                    hint ? element("small", { text: hint }) : document.createTextNode("")
                ]),
                input
            ]));
        }
    });
    form.appendChild(element("button", { type: "submit", text: "Save settings" }));
    form.dataset.schema = JSON.stringify(schema);
}

async function loadBans() {
    const { bans, threshold } = await api("GET", "bans");
    const container = $("bansTable");
    container.textContent = "";
    container.appendChild(table(["IP", "Failed attempts", "Banned until", ""], bans.map((ban) => [
        ban.ip,
        `${ban.failures} / ${threshold}`,
        ban.bannedUntil ? formatTime(ban.bannedUntil) : "Not banned",
        element("button", { type: "button", class: "button-secondary", text: "Clear", onclick: async () => {
            await api("POST", "bans/clear", { ip: ban.ip });
            toast(`Cleared ${ban.ip}`);
            loadBans();
        } })
    ]), "No failed password attempts."));
}

async function loadFiles() {
    const { files } = await api("GET", "files");
    const container = $("filesTable");
    container.textContent = "";
    container.appendChild(table(["File", "Password", "Auto-delete", "Downloads", ""], files.map((file) => [
        file.path,
        file.protected ? "Yes" : "No",
        file.deleteAt ? formatTime(file.deleteAt) : "Never",
        file.maxDownloads < 0 ? `${file.downloadCount} / unlimited` : `${file.downloadCount} / ${file.maxDownloads}`,
        element("button", { type: "button", class: "button-danger", text: "Delete", onclick: async () => {
            if (!confirm(`Delete ${file.path}?`)) return;
            await api("POST", "files/delete", { path: file.path });
            toast(`Deleted ${file.path}`);
            loadFiles();
        } })
    ]), "No files with auto-delete, download limits or passwords."));
}

/* Forms */

function guard(handler) {
    return async (event) => {
        event.preventDefault();
        showError(null);
        const button = event.target.querySelector("button[type=submit]");
        if (button) button.disabled = true;
        try {
            await handler(event);
        } catch (error) {
            showError(error.message);
        } finally {
            if (button) button.disabled = false;
        }
    };
}

$("setupForm").addEventListener("submit", guard(async (event) => {
    const form = event.target;
    if (form.secret.value !== form.repeat.value) throw new Error("The secret keys don't match.");
    applyStatus(await api("POST", "setup", { secret: form.secret.value }));
    form.reset();
}));

$("loginForm").addEventListener("submit", guard(async (event) => {
    const form = event.target;
    applyStatus(await api("POST", "login", { secret: form.secret.value }));
    form.reset();
}));

$("configForm").addEventListener("submit", guard(async (event) => {
    const form = event.target;
    const schema = JSON.parse(form.dataset.schema);
    const changes = {};
    Object.keys(schema).forEach((key) => {
        const input = form.elements[key];
        changes[key] = schema[key] == "boolean" ? input.checked : Number(input.value);
    });
    await api("PUT", "config", changes);
    toast("Settings saved");
}));

$("rotateForm").addEventListener("submit", guard(async (event) => {
    const form = event.target;
    if (form.next.value !== form.repeat.value) throw new Error("The new secret keys don't match.");
    await api("POST", "rotate", { current: form.current.value, next: form.next.value });
    form.reset();
    toast("Secret key changed");
}));

$("logoutButton").addEventListener("click", async () => {
    await api("POST", "logout", {});
    csrfToken = null;
    refreshStatus();
});

document.querySelectorAll("[data-refresh]").forEach((button) => {
    button.addEventListener("click", () => {
        (button.dataset.refresh == "bans" ? loadBans : loadFiles)().catch((error) => showError(error.message));
    });
});

refreshStatus().catch((error) => showError(error.message));
