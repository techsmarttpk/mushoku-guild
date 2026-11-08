# Troubleshooting

| Symptom | Cause and fix |
|---------|---------------|
| Windows says "Windows protected your PC" when running the installer | The installer is not code-signed. Check the SHA-256 against the release notes, then *More info → Run anyway*. |
| Blank window or "WebView2" error | Install the Microsoft Edge WebView2 runtime (Evergreen) and start again. |
| Claude chip shows a hollow dot / "not detected" | Install Claude Code, run `claude` once in a terminal and sign in, then in the **Guild** tab use **Choose claude.exe…** if it is not on PATH. |
| ChatGPT will not connect | Port 1455 may be busy (the app falls back to another port); allow the browser to return to `localhost`; try **Connect ChatGPT** again. The sign-in is experimental and may stop working if the provider changes it. |
| ChatGPT stops answering after a while | The session expired or was revoked. Disconnect and connect again. |
| "Trust this repository" prevents starting a quest | Trust is required per repository (Guild tab, Permissions). It must be confirmed again if the folder moved. |
| A quest waits and nothing happens | A permission request is waiting; answer the dialog. It is denied automatically after 10 minutes. |
| Repo tab shows "Reading Git state…" or no branch | The folder is not a Git repository, or `git` is not on PATH. Run `git --version` in a terminal. |
| Behind/ahead looks wrong | The view is only as fresh as the last fetch. Use **Fetch**. |
| Pull fails with "Not possible to fast-forward" | Your branch and the remote have diverged. Pull with rebase or merge, or merge/rebase manually. |
| Push asks for credentials or fails with authentication errors | Mushoku Guild disables Git prompts. Sign in once with Git Credential Manager (for example run `git push` in a terminal), then retry. |
| Saving asks about overwriting | The file changed on disk after you opened it. Reload from disk or overwrite deliberately. |
| A Mermaid diagram shows an error box | The syntax is invalid (the box shows the parser message), or the diagram type is not supported by the bundled Mermaid version. Use **Show source** to read it. |
| Command panel says to trust the repository | The command runner works only in trusted repositories. |
| High memory use | The WebView2 processes dominate; see `docs/measurements/`. Claude Code is measured separately. |
| Start-up error after an update | The database is migrated with additive migrations. If its integrity check fails, the file is moved aside (`mushoku.corrupt-<timestamp>`) and a new one is created; your old file is kept. |

## Where is my data?

- App database (`mushoku.db`) and per-run files: `%APPDATA%\com.techsmarttpk.mushokuguild\`
- ChatGPT refresh token: Windows Credential Manager, entries named "Mushoku Guild"
- Nothing is stored inside your repositories by the app (except changes you or Claude make).

## Reporting a problem

Open an issue at <https://github.com/techsmarttpk/mushoku-guild/issues>. Include the version, what you did and the visible message. Do not paste tokens, passwords or private code.
