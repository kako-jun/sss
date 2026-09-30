# sss - Smart Slide Show

_[日本語版はこちら](README.md)_

A slideshow app that shows 100,000+ photos fairly.

## Features

- **Complete-equality random display**: every photo is shown once before any repeat
- **Fast incremental scanning**: only files whose modification time (mtime) changed since the last scan are processed. On startup the previous state is restored immediately and the scan runs in the background
- **Video support**: besides still images (JPEG/PNG/GIF/BMP/WebP/TIFF), videos (MP4/WebM/OGV/M4V) play in the same rotation
- **4K optimized**: automatic resizing and caching for high-resolution displays
- **Tauri protocol image loading**: efficient, cross-platform file loading
- **5-image prefetch cache**: smooth transitions (single-threaded, works on weak CPUs too)
- **Display stats**: tracks and shows display count and last-shown time
- **EXIF info display**: shows date taken and GPS coordinates
- **Exclude rules**: manage exclude rules by date, file, or folder in Settings → Exclude Rules (a legacy `.sssignore` file is migrated to the database automatically on first scan)
- **Video audio and max duration**: toggle video audio on/off (default: off) and cap playback time (unlimited / 30s / 1 min / 2 min / 5 min; default: unlimited) in Settings
- **Screensaver suppression**: keeps the display always on
- **Cross-platform**: Windows/Linux/macOS
- **Japanese/English UI**: follows the OS locale automatically, with a manual switch in Settings → Options

## Installation

### Prebuilt binaries (Releases)

Download the file for your OS from [Releases](https://github.com/kako-jun/sss/releases) (the latest is currently v1.0.0).

| OS      | File                                                            |
| ------- | --------------------------------------------------------------- |
| Windows | `sss_*_x64-setup.exe` (NSIS installer) / `sss_*_x64_en-US.msi`  |
| macOS   | `sss_*_universal.dmg` (Apple Silicon and Intel)                 |
| Linux   | `sss_*_amd64.AppImage` / `sss_*_amd64.deb` / `sss-*.x86_64.rpm` |

**v1.0.0 does not include later changes such as video slideshow playback, the Japanese/English UI, the reworked Stats tab, the Space / F / F11 / ? shortcuts, click/wheel on the photo, undo and window-state memory (see `[Unreleased]` in [CHANGELOG.md](CHANGELOG.md)).** To use the latest `main`, build from source (below). The current release workflow builds only the NSIS installer (`setup.exe`) for Windows (the v1.0.0 `.msi` came from an earlier build).

#### About the unsigned app warning

The distributed files are not code-signed, so the OS shows a warning on first launch.

- **Windows (SmartScreen)**: when "Windows protected your PC" appears, choose "More info" -> "Run anyway"
- **macOS (Gatekeeper)**: when the app "cannot be opened because the developer cannot be verified", right-click (Control-click) the app in Finder and choose "Open", or click "Open Anyway" under System Settings -> Privacy & Security. If it still won't open, run `xattr -dr com.apple.quarantine /Applications/sss.app` in Terminal
- **Linux**: no warning. Make an AppImage executable first with `chmod +x sss_*.AppImage`

### Build from source

#### Requirements

- Node.js (v20.19+ or v22.12+, required by Vite 7; CI uses Node 22)
- Rust (v1.90+, via rustup; MSRV of tauri 2.12)
- Linux only: Tauri's build dependencies (same as CI; Ubuntu 22.04 example):

```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf
```

#### Setup

```bash
# Install dependencies
npm install

# Start the dev server
npm run tauri:dev

# Build
npm run tauri:build
```

#### Development commands

```bash
npm test          # frontend tests (vitest)
npm run lint      # ESLint
npm run e2e       # real-browser e2e (local only; see e2e/README.md)
cd src-tauri && cargo test   # backend tests
```

## Usage

### First launch

1. If no photo folder has ever been set, a welcome screen appears (the first launch is fullscreen)
2. Click "Select Folder" to open Settings (Folder tab). Click "Select" to open the dialog and choose a folder with your photos/videos (scanning starts as soon as you choose)
3. When the scan finishes, the number of new/deleted files and so on is shown
4. Close Settings (the X button at the top right, or ESC) and the slideshow plays

On later launches the previous folder is restored automatically and shown right away; the scan for changes runs in the background.

### Basic controls

#### Mouse

- **Move the mouse**: shows the overlay UI (the bar at the bottom center) and the top-right buttons. After 3 seconds without mouse movement they fade out and the mouse cursor is hidden too
- **Hover over the overlay bar**: the slideshow pauses automatically while the pointer is on the bar and resumes when it leaves (merely moving the mouse does not pause it). It also stays paused while Settings is open
- **Click the photo**: toggles pause/resume (rapid clicks and double-clicks count as one; it doesn't interfere with the overlay buttons or the Settings dialog)
- **Wheel over the photo / horizontal trackpad swipe**: previous/next photo (one step per gesture, so inertial scrolling doesn't skip several photos)
- **Overlay buttons**:
  - **Previous**: goes back to the previous photo/video (from history, does not increase its display count)
  - **Pause/Play**: toggles pause/resume
  - **Next**: advances immediately
  - **Pick** (hand icon): copies the current file into the pick folder (default: `Pictures/sss-picked`)
  - **"…" menu**: open in file manager, view picks, exclude (by date taken / folder / file)
  - **Map thumbnail** (photos with GPS only): click to open Google Maps
- **Undo**: for a few seconds right after an exclude or a pick, a small toast offers "Undo". It removes the exclude rule and puts the photo back into the unplayed part of the playlist, or deletes the file the pick just copied (no confirmation dialog)
- **Top-right buttons** (from left: shortcuts, window mode, settings, exit): shown while you're using the mouse, and fade out on idle just like the overlay
- **Window state is remembered**: the window mode (fullscreen/windowed), position and size are saved on exit and restored on the next launch. If the saved display is gone, the window opens at the default position

#### Keyboard shortcuts

- **ESC**: quit the app (if Settings, the shortcuts overlay or the "…" menu is open, it only closes that)
- **Left arrow**: go to the previous photo/video
- **Right arrow**: go to the next photo/video
- **Space**: toggle pause/resume (disabled while Settings is open)
- **F / F11**: toggle fullscreen and windowed mode (on macOS, `F11` is often bound to the OS's Mission Control and may never reach the app; use `F`, or `fn + F11`, instead)
- **?**: show the keyboard shortcuts overlay (it also lists the click/wheel gestures on the photo)

### Exclude rules

The Settings → Exclude Rules tab lists and manages exclude rules by date, file, or folder (the overlay's "…" menu also lets you exclude the currently shown photo by date/file/folder on the spot). Rules are stored in the app's own database.

A legacy `.sssignore` file (gitignore-style, in your home directory: Windows `%USERPROFILE%`, Unix `$HOME`) from older versions is migrated into the database once, on the first scan, and then renamed to `.sssignore.bak` (it is never read again after that).

### Settings

Open it with the gear button at the top right (or the button on the welcome screen). It has seven tabs:

| Tab           | Contents                                                                                                                               |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Folder        | Choose the photo folder (it is scanned right away) or re-scan the selected folder (result: files, new, deleted, duration, read errors) |
| Options       | Display interval (5-60 s), follow EXIF rotation, video audio (default: off) and max playback time, pick folder, language               |
| Exclude Rules | List, remove and manually add exclude rules                                                                                            |
| Picks         | List and delete picked photos/videos                                                                                                   |
| History       | Recently shown photos (latest 100) and excluding from there                                                                            |
| Stats         | Display-count distribution (bar chart / table) and "Reset Display Counts"                                                              |
| Info          | Version, GitHub link, "Reset All Data" (erases all data and restarts the app; picked files are kept)                                   |

A video advances after it plays to the end (or reaches the "Maximum video playback time"), not after the display interval. The language can be Auto (OS locale) / 日本語 / English.

## Tech Stack

### Backend (Rust)

- **Tauri v2**: desktop app framework (latest, mobile-ready)
- **rusqlite v0.40**: SQLite database
- **rayon v1**: parallel processing
- **image v0.25**: image processing (4K resizing)
- **kamadak-exif v0.6**: EXIF reading
- **md5 v0.8**: cache filename hashing
- **globset v0.4**: exclude-rule glob pattern matching
- **keepawake v0.6**: screensaver suppression
- **walkdir v2**: folder traversal
- **Tauri plugins**: dialog (folder picker; used only from the Rust side, no WebView permission), opener (open URLs), process (exit), single-instance (prevents multiple launches), window-state (remembers window state)

### Frontend (React)

- **React 19**: UI library
- **TypeScript**: type safety
- **Vite v7**: fast build tool
- **Framer Motion**: animation
- **uPlot**: stats chart
- **TailwindCSS v3**: styling
- **Lucide React**: icons

## Overlay UI info

Shown in the rounded bar that floats at the bottom center when you move the mouse
(nothing is shown for information that isn't there):

- 🗺️ Location (a small map thumbnail, only when the photo has GPS data; click to open Google Maps)
- 📅 Date taken (only when EXIF has one)
- 📁 File name and playlist position (e.g. 1,234 / 100,000)
- File size, display count, and last-shown time are one hover away, in the filename's tooltip
- A thin line along the bottom edge of the photo shows the progress until the next photo

Per-photo display counts and last-shown times are available in Settings → History and Settings → Stats.

## Performance

- First scan (100k photos): < 30s
- Incremental scan (100 changed files): < 3s
- Startup to slideshow start: < 5s (with incremental scan)
- Image transition: < 100ms
- Memory usage: < 500MB

These are targets. For measured benchmarks (`src-tauri/tests/scan_reflection_throughput.rs` / `db_reflection_throughput.rs`, both `#[ignore]`), see `docs/architecture.md` section 6 ("差分スキャン", Japanese only).

## Running as a signage display

For always-on use, we recommend letting the OS manage auto-start/stop:

### Windows: Task Scheduler

- Start at 8:00, stop at 22:00
- Keeps working after a PC restart

### Linux: cron / systemd timer

- Set start/stop times with cron

### macOS: launchd

- Configure start/stop times with a plist file

See `CLAUDE.md` (Japanese) for details.

## Related tools

### Pairing with photo-returns

[photo-returns](https://github.com/kako-jun/photo-returns) organizes photos and videos from your camera or phone into a `YYYY/YYYYMM/YYYYMMDD` folder structure based on EXIF metadata.

**Recommended flow:**

1. Use **photo-returns** to organize photos from your camera/phone into date-based folders
2. Use **sss** to enjoy the organized folder as a slideshow

sss (which gives every photo a fair turn) and photo-returns (which keeps photos easy to find) work well together.

## License

MIT

## Author

kako-jun
