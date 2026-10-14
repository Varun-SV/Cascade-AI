# Desktop Application

The desktop client is an **Electron + React** application, packaged separately from the npm CLI. Download links are published from [cascadeai.in/download](https://cascadeai.in/download), with installers built through repository release automation.

## Main areas

- **Chat:** enter prompts, see streaming responses, approvals and run history.
- **Cockpit:** inspect the live T1/T2/T3 agent graph, node activity and communications.
- **Code workspace:** file tree, Monaco editor, diff views and integrated terminal.
- **Built-in browser:** browse normally, inspect the current page, and permit the agent to operate the page when explicitly enabled.
- **Settings:** configure providers and models, account connection and related preferences.

The desktop host contains privileged native functionality; the renderer communicates through preload/IPC rather than obtaining raw Node access for every interaction.

## Browser behavior

The desktop's current-page interaction is intentionally different from a disposable headless browser. It may act on a signed-in page, so it has a separate `agentBrowserControl` configuration switch (off by default) and remains subject to approvals and stop/takeover behavior. See [[Browser-Control]].

## Development

```bash
npm install
npm run build:cli
npm run dev:app
npm run build:app
```

Platform packages are defined in `app/electron-builder.yml` and app workspace scripts. Platform-specific native modules may need rebuilding; code signing and packaging requirements depend on the target OS.

Sources: [desktop app](https://github.com/Varun-SV/Cascade-AI/tree/main/app), [Electron main process](https://github.com/Varun-SV/Cascade-AI/blob/main/app/electron/main.ts), [app package](https://github.com/Varun-SV/Cascade-AI/blob/main/app/package.json).
