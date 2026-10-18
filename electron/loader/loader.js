// Displays the connection state sent by main.js, first as the `status` query
// parameter, then through update_loader():
// { server, state ("connecting" | "retrying" | none), attempt, since, error, retry }
const dom = {
    body: document.body,
    title: document.getElementById("title"),
    server: document.getElementById("server"),
    status: document.getElementById("status"),
    error: document.getElementById("error"),
    buttons: document.getElementById("buttons"),
    retry: document.getElementById("retry")
};

let status = {};
let retry_at = 0;

function format_duration(ms) {
    let seconds = Math.floor(ms / 1000);
    if (seconds < 60)
        return seconds + " s";
    return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0") + " min";
}

function tick() {
    if (!status.server)
        return;
    let waited = Date.now() - status.since;
    if (status.state === "retrying") {
        let left = Math.max(0, Math.ceil((retry_at - Date.now()) / 1000));
        dom.status.textContent = "Retrying in " + left + " s · waiting for " + format_duration(waited);
    } else {
        dom.status.textContent = (status.attempt > 1 ? "Attempt " + status.attempt + " · " : "") +
            "waiting for " + format_duration(waited);
        // the buttons show right after a failure, or once waiting exceeds 10 s
        if (waited > 10000)
            dom.buttons.hidden = false;
    }
}

function update_loader(new_status) {
    status = new_status;
    retry_at = Date.now() + (status.retry || 0) * 1000;

    let configured = !!status.server;
    let retrying = configured && status.state === "retrying";
    dom.body.classList.toggle("retrying", retrying);
    dom.body.classList.toggle("idle", !configured);
    dom.title.textContent = !configured ? "No server configured"
        : retrying ? "Server not reachable" : "Connecting to OpenVOCS";
    dom.server.textContent = status.server || "";
    dom.error.textContent = retrying ? status.error || "" : "";
    dom.error.hidden = !dom.error.textContent;
    dom.buttons.hidden = configured && !retrying && status.attempt === 1;
    dom.retry.hidden = !configured;
    dom.status.textContent = "";
    tick();
}

try {
    update_loader(JSON.parse(new URLSearchParams(location.search).get("status")));
} catch {
    update_loader({});
}
setInterval(tick, 500);
