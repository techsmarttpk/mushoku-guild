# Installation

## Requirements

| Requirement | Detail |
|-------------|--------|
| OS | Windows 10 or 11, x64 |
| WebView2 runtime | Already on Windows 11. If missing, the installer downloads the Evergreen bootstrapper (needs internet) |
| Git | `git` on PATH, needed by the Repo tab and project context |
| Claude Code CLI | Installed and signed in by you (not bundled). Needed to run quests and research |
| ChatGPT account | Needed for prompt engineering and Guild Chat (experimental sign-in, see [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md)) |

Mushoku Guild bundles no credentials and no Claude Code.

## Install

1. Get `Mushoku-Guild_<version>_windows-x64_setup.exe` from the GitHub Releases page (when one is published) or build it ([DEVELOPMENT.md](DEVELOPMENT.md)).
2. Verify the checksum in PowerShell and compare it with the value in the release notes:

   ```powershell
   Get-FileHash .\Mushoku-Guild_0.1.0_windows-x64_setup.exe -Algorithm SHA256
   ```

3. Run the installer. It installs for the current user (no administrator rights), creates a Start menu shortcut and an uninstaller. An earlier install folder is reused on upgrades (observed when reinstalling over a previous install).
4. Start **Mushoku Guild** from the Start menu.

### SmartScreen warning

The installer is **not code-signed**. Windows may show "Windows protected your PC" or "Unknown publisher". That is expected for unsigned software; it is not evidence of malware, and it is not evidence of safety either. Only continue (*More info → Run anyway*) if you obtained the file from the project's repository or release page and the SHA-256 matches.

### Silent install (optional)

```powershell
.\Mushoku-Guild_0.1.0_windows-x64_setup.exe /S
```

## Upgrade

Run the newer installer over the old one. Your data is kept: the database lives outside the install folder and migrations are additive.

## Uninstall

Use *Settings → Apps → Mushoku Guild*, or `uninstall.exe` in the install folder. Your data is **kept** by default:

- `%APPDATA%\com.techsmarttpk.mushokuguild\` (database, run files). Delete this folder to remove all conversations, quests and settings.
- Windows Credential Manager entries named "Mushoku Guild" (the ChatGPT refresh token). Remove them in *Control Panel → Credential Manager → Windows Credentials*, or use **Disconnect** in the Guild tab before uninstalling.

## Standalone executable

`Mushoku-Guild_<version>_windows-x64.exe` is the same release build without installer. It needs the WebView2 runtime and stores data in the same location. It is unsigned too.

## First run

See "Getting started" in the [README](../README.md#getting-started). Problems: [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
