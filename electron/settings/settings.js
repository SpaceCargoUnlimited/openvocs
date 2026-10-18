const fields = {
    server: document.getElementById("server")
};
const error = document.getElementById("error");

// the admin link follows the address as it is typed
async function update_admin_link() {
    let url = await window.openvocs_settings.admin_url(fields.server.value);
    document.getElementById("admin").hidden = !url;
    document.getElementById("admin_url").textContent = url;
}

function show_window_position(text) {
    document.getElementById("window_position").textContent = text
        ? "Saved: " + text + "."
        : "Not saved: the window opens centered at the default size.";
    document.getElementById("reset_window").disabled = !text;
}

window.openvocs_settings.get().then(settings => {
    fields.server.value = settings.server;
    update_admin_link();
    show_window_position(settings.windowPosition);
});

document.getElementById("save_window").addEventListener("click", async () => {
    show_window_position(await window.openvocs_settings.save_window_position());
});

document.getElementById("reset_window").addEventListener("click", async () => {
    show_window_position(await window.openvocs_settings.reset_window_position());
});

fields.server.addEventListener("input", update_admin_link);

document.getElementById("form").addEventListener("submit", async event => {
    event.preventDefault();
    error.textContent = "";
    try {
        await window.openvocs_settings.save({
            server: fields.server.value
        });
    } catch (err) {
        error.textContent = String(err.message).replace(/^.*Error: /, "");
    }
});

document.getElementById("open_admin").addEventListener("click", event => {
    event.preventDefault();
    window.openvocs_settings.open_admin(fields.server.value);
});

document.getElementById("cancel").addEventListener("click", () => {
    window.openvocs_settings.cancel();
});
