const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("openvocs_settings", {
    get: () => ipcRenderer.invoke("settings:get"),
    save: (values) => ipcRenderer.invoke("settings:save", values),
    cancel: () => ipcRenderer.invoke("settings:cancel"),
    admin_url: (server) => ipcRenderer.invoke("admin:url", server),
    open_admin: (server) => ipcRenderer.invoke("admin:open", server)
});
