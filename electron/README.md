# openvocs desktop

Electron shell for the openvocs web front-end. The app does not include the interface: it
always loads it from the server at `https://<server>/app/vocs/`, so it always matches the
server's version and its `config_vocs.js`.

## Quick start

```sh
cd electron
npm install
npm start
```

The first time it runs, the app opens **Server Settings**. Enter the host of your openvocs server
(for example `openvocs.example.org` or `10.0.0.5:443`). You can reopen this window later with
**openvocs > Server Settings…** (`Cmd/Ctrl+,`). It also has an **Open admin page** link, which opens
`https://<server>/app/vocs_admin/` in a separate window so the voice session keeps running.

Settings are saved in `settings.json` in the app's user-data folder:

- macOS: `~/Library/Application Support/openvocs/`
- Windows: `%APPDATA%\openvocs\`
- Linux: `~/.config/openvocs/`

## Desktop behavior

- **Loader:** a local loading screen stays up until the server answers. The app first checks
  the server with a request on `/app/vocs/` and only then loads the interface. If the
  check fails (connection refused, no answer within 20 s, certificate error or HTTP 5xx), the
  loader shows the error and retries after 1, 2, 4 and 8 s, then every 15 s. After a failure,
  or after 10 s of waiting, it also offers **Retry now** and **Server Settings…**.

- The app grants microphone, speaker selection, fullscreen and notifications automatically,
  but only to the configured server. On macOS, it asks for microphone
  access at startup.
- The server needs a certificate trusted by the operating system. Self-signed certificates
  are rejected, and the loader shows the certificate error.
- **Push-to-talk:** gamepad button 0 works even when the window is not focused, is covered
  by other windows, or is minimized. The app keeps the page running in the background, so the
  front-end keeps reading the gamepad. Keyboard PTT (space bar) only works while the window
  is focused. Press a gamepad button once after launch: browsers only expose a gamepad after
  its first input.
- External links open in the system browser. Navigation to other origins is blocked.
- Only one instance can run at a time.

## Packaging

```sh
npm run dist         # current platform
npm run dist:mac     # dmg + zip (hardened runtime, microphone entitlement)
npm run dist:win     # NSIS installers: x64, arm64 and a combined one that picks the right one
npm run dist:mac-win # both, from macOS (no Wine needed)
npm run dist:linux   # AppImage + deb
```

Output goes to `electron/dist/`. You need code signing and notarization identities to ship a signed
macOS build.

---

© Space Cargo Unlimited S.A.S. · Data classification: INTERNAL
