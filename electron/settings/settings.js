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

window.openvocs_settings.get().then(settings => {
    fields.server.value = settings.server;
    update_admin_link();
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
