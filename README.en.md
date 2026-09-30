# sss - Smart Slide Show

_[日本語版はこちら](README.md)_

A slideshow app that shows 100,000+ photos fairly.

## Features

- **Complete-equality random display**: every photo is shown once before any repeat
- **Fast incremental scanning**: only changed files are detected on startup
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

### Requirements

- Node.js (v20.19+, required by Vite 7)
- Rust (v1.90+, via rustup; MSRV of tauri 2.12)

### Setup

```bash
# Install dependencies
npm install

# Start the dev server
npm run tauri:dev

# Build
npm run tauri:build
```

## Usage

### First launch

1. If no photo folder has ever been set, a welcome screen appears
2. Click "Select Folder" to open Settings, then pick a photo folder in the Folder tab
3. Start scanning with the "Scan" button
4. The slideshow starts automatically once the scan finishes

### Basic controls

#### Mouse

- **Move the mouse**: shows the overlay UI and pauses the slideshow automatically
- **Click outside the overlay**: hides the UI immediately and resumes
- **Previous button**: goes back to the previous photo/video (from history, does not increase its display count)
- **Next button**: advances immediately
- **"…" menu** (inside the overlay): open the file manager, view your picks, or exclude by date/file/folder
- **Top-right buttons** (exit, shortcuts, window mode, settings): shown while you're using the mouse, and fade out on idle just like the overlay

#### Keyboard shortcuts

- **ESC**: quit the app (just closes Settings or the shortcuts overlay if either is open)
- **Left arrow**: go to the previous photo/video
- **Right arrow**: go to the next photo/video
- **Space**: toggle pause/resume
- **F / F11**: toggle fullscreen and windowed mode (on macOS, `F11` is often bound to the OS's Mission Control and may never reach the app; use `F`, or `fn + F11`, instead)
- **?**: show the keyboard shortcuts overlay

### Exclude rules

The Settings → Exclude Rules tab lists and manages exclude rules by date, file, or folder (the overlay's "…" menu also lets you exclude the currently shown photo by date/file/folder on the spot). Rules are stored in the app's own database.

A legacy `.sssignore` file (gitignore-style, in your home directory: Windows `%USERPROFILE%`, Unix `$HOME`) from older versions is migrated into the database once, on the first scan, and then renamed to `.sssignore.bak` (it is never read again after that).

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

### Frontend (React)

- **React 19**: UI library
- **TypeScript**: type safety
- **Vite v7**: fast build tool
- **Framer Motion**: animation
- **TailwindCSS v3**: styling
- **Lucide React**: icons

## Overlay UI info

Shown in the rounded bar that floats at the bottom center when you move the mouse
(#66: nothing is shown for information that isn't there):

- 🗺️ Location (a small map thumbnail, only when the photo has GPS data; click to open Google Maps)
- 📅 Date taken (only when EXIF has one)
- 📁 File name and playlist position (e.g. 1,234 / 100,000)
- File size, display count, and last-shown time are one hover away, in the filename's tooltip

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
