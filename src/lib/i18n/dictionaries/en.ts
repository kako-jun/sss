/**
 * English dictionary (#80).
 *
 * Same flat key set as `ja.ts` (enforced by `messages.test.ts`). `{param}`
 * placeholders are substituted by `t(key, params)`. Translations aim for
 * natural UI English rather than literal renderings of the Japanese source.
 */
export const en = {
  // === App-wide ===
  windowTitle: 'sss - Smart Slide Show',
  exitTooltip: 'Exit (Esc)',
  settingsTitle: 'Settings',
  switchToWindowMode: 'Switch to windowed mode',
  switchToFullscreen: 'Switch to fullscreen',
  windowModeLabel: 'Windowed',
  fullscreenLabel: 'Fullscreen',
  windowModeToggleFailed: "Couldn't switch window mode",
  exitFailed: "Couldn't exit the app",
  genericErrorTitle: 'Something went wrong',
  closeTooltip: 'Close',
  cancelButton: 'Cancel',
  confirmDialogTitle: 'Confirm',
  confirmDialogMoreHint: 'Arrow keys: scroll for more',

  // === Keyboard shortcuts (#66) ===
  shortcutsButtonTooltip: 'Keyboard shortcuts (?)',
  shortcutsTitle: 'Keyboard Shortcuts',
  shortcutSpace: 'Pause / resume',
  shortcutNavigate: 'Previous / next',
  shortcutFullscreen: 'Toggle fullscreen',
  shortcutEscape: 'Exit (closes Settings first if open)',
  shortcutHelp: 'Show this help',
  shortcutPhotoClick: 'On the photo: pause / resume',
  shortcutPhotoWheel: 'On the photo: previous / next (or swipe sideways)',
  // #66 visual refresh: caption next to the "?" badge on the welcome screen
  // (the badge itself is a fixed "?" glyph in the JSX; this is just the label).
  shortcutsHintWelcome: 'Show keyboard shortcuts',

  // === Startup notice screens (#65) ===
  welcomeTitle: 'Welcome to SSS',
  welcomeSubtitle: 'Select a photo folder to start the slideshow',
  selectFolder: 'Select Folder',
  openSettings: 'Open Settings',
  loadingPlaylist: 'Loading playlist...',
  pleaseWait: 'Please wait',
  emptyPlaylistTitle: 'No photos to show',
  emptyPlaylistSubtitle:
    'Everything may be excluded by your rules, or the folder has no supported files. Check Settings to review.',
  directoryUnreachableTitle: "Can't read your last folder",
  directoryUnreachableSubtitle: 'Check the connection, or pick a different folder in Settings',
  rootUnavailable: "Can't connect to the folder. Waiting to reconnect...",
  loadFailedGaveUp: 'Several photos failed to load. Check the folder connection.',
  // #120: all of the photos in a row failed to render (corrupt / 0-byte files).
  noReadableImagesTitle: 'No photos could be loaded',
  noReadableImagesSubtitle:
    'Every file may be corrupted or empty.\nCheck the folder in Settings, then rescan.',
  // Not necessarily every photo, but too many in a row failed, so playback stopped.
  mediaFailureStreakTitle: 'Several photos in a row failed to load',
  mediaFailureStreakSubtitle:
    'The files may be corrupted or empty.\nChoose Continue to try the next photos.',
  continueSlideshow: 'Continue',
  mediaSkipToast: 'Skipping unreadable photos ({count} in a row)',
  startupDirectoryRejected: "Couldn't connect to your last folder: {reason}",

  // === Startup sequence status text (src/lib/startup.ts) ===
  statusLoadingSettings: 'Loading settings...',
  statusCheckingLastFolder: 'Checking your last folder...',
  statusRestoringState: 'Restoring your last session...',
  statusLoadingImages: 'Loading images...',
  statusScanningDirectory: 'Scanning folder...',
  statusScanComplete: 'Scan complete: {count} files found',

  // === Overlay UI ===
  menuTooltip: 'Menu',
  pickTooltip: 'Pick (copy)',
  previousTooltip: 'Previous (←)',
  nextTooltip: 'Next (→)',
  pauseTooltip: 'Pause',
  playTooltip: 'Play',
  openInFileManager: 'Open in file manager',
  viewPicks: 'View picks',
  excludeMenuLabel: 'Exclude',
  excludeByDate: 'Exclude by date taken',
  excludeByDirectory: 'Exclude this folder',
  excludeByFile: 'Exclude this file',
  locationMapAlt: 'Location map',
  // #66 visual refresh: file size, display count, and last-displayed time are no
  // longer shown inline; they're folded into the filename's title tooltip.
  displayCountTooltip: 'Shown {count} times',
  lastDisplayedTooltip: 'Last shown: {when}',
  pickCopyDone: 'Copied to {path}',
  pickCopyFailed: "Couldn't copy the photo",
  errorPickPermissionDenied: "Couldn't copy: no permission to write to the pick destination",
  errorPickDiskFull: "Couldn't copy: the pick destination is out of space",
  errorPickDestinationMissing: "Couldn't copy: the pick destination folder wasn't found",
  errorPickSourceMissing: "Couldn't copy: the original photo wasn't found",
  errorPathNotManaged: "This file isn't managed by the slideshow, so it can't be copied",
  errorShareDirectoryInvalid:
    "This folder can't be used as the pick destination (not allowed: root, home folder, relative paths, etc.)",
  errorShareDirectoryLoadFailed: "Couldn't load the pick destination",
  errorShareDirectoryRefreshFailed:
    'The pick destination was saved, but the display could not be refreshed',
  errorShareDirectorySaveFailed: "Couldn't save the pick destination",
  errorNotMediaFile: "This isn't an image or video file, so it can't be copied",
  errorOpenNotManaged:
    "This file isn't managed by the slideshow, so it can't be shown in the file manager",
  errorImageFileNotFound: 'File not found',
  openInExplorerFailed: "Error: couldn't open the file manager",
  excludeFailed: 'Error: exclude failed',
  errorExcludeNotManaged: "This file isn't managed by the slideshow, so it can't be excluded",
  // #78: brief toast right after exclude/pick, with an Undo button for a few seconds
  undoButton: 'Undo',
  undoExcludeDone: 'Exclusion undone',
  undoExcludeNothing: 'Nothing to undo',
  undoPickDone: 'Pick undone',
  undoFailed: "Error: couldn't undo",
  excludeAddedFile: 'Exclude rule added: {pattern}',
  excludeAddedNeedsRescan: 'Exclude rule added: {pattern} (rescan to apply the change)',

  // === Settings: shared ===
  loadingLabel: 'Loading...',
  // #115: failures must not look like "empty" or success, so loads, saves and actions say so
  loadFailed: "Couldn't load this",
  retryButton: 'Retry',
  settingLoadFailed: "Couldn't load the setting. Showing the default.",
  intervalSaveFailed: "Couldn't save the display interval. Reverted to the previous value.",
  exifSaveFailed: "Couldn't save the EXIF rotation setting. Reverted to the previous value.",
  videoSaveFailed: "Couldn't save the video settings. Reverted to the previous value.",
  languageSaveFailed: "Couldn't save the language setting. Reverted to the previous value.",
  startupSettingsLoadFailed:
    "Couldn't load your saved settings. The display interval and video settings are using defaults.",
  startupInitFailedTitle: "Couldn't finish loading at startup",
  startupFailedSubtitle: 'Try again, or choose the folder again in Settings.',
  errorPickSourceUnreadable: "Couldn't copy: the original photo can't be read",
  removeRuleFailed: "Couldn't remove the exclude rule",
  deletePickedFailed: "Couldn't delete the picked photo",
  resetDisplayCountsFailed: "Couldn't reset the display counts",
  openGitHubFailed: "Couldn't open GitHub",
  versionUnavailable: 'unavailable',
  errorLastDirectoryLoadFailed: "Couldn't load the last folder",
  selectButtonLabel: 'Select',
  secondsUnit: '{value}s',
  secondsUnitOnly: 's',

  // === Settings: tabs ===
  settingsTabsLabel: 'Settings tabs',
  tabScan: 'Folder',
  tabOptions: 'Options',
  tabExclude: 'Exclude Rules',
  tabPick: 'Picks',
  tabHistory: 'History',
  tabStats: 'Stats',
  tabInfo: 'Info',

  // === Settings: Import (scan) ===
  directorySelectionTitle: 'Select Folder',
  // #66 visual refresh: description for the heading+description+control rhythm.
  directorySelectionDescription:
    'Choosing a folder with Select scans it right away; Scan re-scans the selected folder. Only what changed since last time is detected, so even 100,000+ photos take seconds',
  scanningLabel: 'Scanning...',
  scanLabel: 'Scan',
  scanResultTitle: 'Scan Results',
  fileCountLabel: 'Files:',
  newFilesLabel: 'New:',
  deletedFilesLabel: 'Deleted:',
  durationLabel: 'Duration:',
  readErrorsLabel: 'Read errors:',
  errorCountValue: '{count}',
  keptAsUnknownNote: '(kept in the list, not removed)',
  pleaseSelectDirectoryFirst: 'Please select a folder first',
  failedToScanDirectory: 'Failed to scan the folder',
  errorScanInProgress: 'A scan is already in progress. Please wait for it to finish.',
  errorDirectoryNotFound: "Couldn't find the selected folder: {path}",
  errorDirectoryUnsafe: "This folder can't be used for security reasons: {path}",
  selectDirectoryDialogTitle: 'Select Photo Folder',
  selectShareDirectoryDialogTitle: 'Select Pick Destination Folder',
  errorDialogInProgress: 'A folder dialog is already open',
  errorNoLastDirectory: 'No folder has been selected to scan yet',

  // === Settings: Options ===
  displayIntervalTitle: 'Display Interval',
  displayIntervalDescription: 'Seconds before switching to the next photo or video (5–60s)',
  exifRotationLabel: 'Auto-rotate images based on EXIF orientation',
  videoSectionTitle: 'Video',
  videoAudioLabel: 'Play video audio',
  videoAudioDescription: 'When off, videos play silently',
  videoMaxDurationLabel: 'Maximum video playback time',
  videoMaxDurationDescription: 'Longer videos move on to the next photo or video after this time',
  videoMaxDurationUnlimited: 'Unlimited',
  videoMaxDurationSeconds: '{count}s',
  videoMaxDurationMinutes: '{count} min',
  pickDestinationTitle: 'Pick Destination Folder',

  // === Settings: Exclude Rules ===
  excludeRulesTitle: 'Exclude Rules',
  excludeRulesDescription: 'Manage which photos and videos are left out of the slideshow',
  noExcludeRules: 'No exclude rules yet',
  dateRuleTag: 'Date',
  removeTooltip: 'Remove',
  addPatternPlaceholder: 'Enter a pattern (e.g. **/thumbs/)',
  addButtonLabel: 'Add',
  errorPatternEmpty: 'Please enter a pattern',
  errorInvalidPattern: 'Invalid pattern: {detail}',
  errorAddIgnoreRuleFailed: 'Failed to add the exclude rule',
  addPatternFailedGeneric: 'Failed to add the pattern',
  excludeRuleAddedNeedsRescan: 'Exclude rule added: {pattern}. Rescan to apply the change',
  excludeRuleRemovedNeedsRescan:
    'Exclude rule removed: {pattern}. Rescan to bring the previously excluded photos and videos back into the slideshow',
  excludeRulesChangedNeedsRescan: 'Exclude rules changed. Rescan to apply the changes',
  excludeRescanNow: 'Rescan now',
  excludeRescanOtherScanRunning: 'Please wait until the folder scan finishes',
  excludeRescanning: 'Rescanning...',
  excludeRescanDone:
    'Rescanned. The exclude rules are now applied ({count} items in the slideshow now)',

  // === Settings: Picks ===
  pickListTitle: 'Picked Photos',
  noPickedPhotos: 'No picked photos yet',
  deleteTooltip: 'Delete',
  confirmDeletePickedPhoto:
    "Delete this copy from the pick destination folder? The original photo isn't affected.",

  // === Settings: History ===
  recentHistoryTitle: 'Recently Shown (last 100)',
  noHistoryItems: 'No history yet',
  excludeThisPhoto: 'Exclude this photo',
  excludeThisDate: 'Exclude this date',
  excludeThisFolder: 'Exclude this folder',

  // === Settings: Stats ===
  seriesFileCount: 'Files',
  axisDisplayCount: 'Times shown',
  noStatsData: 'No data yet. Run a scan first.',
  statViewedLabel: 'Shown at least once',
  statAverageLabel: 'Average times shown',
  statRangeLabel: 'Fewest to most',
  fairnessEvenBadge: 'Even (gap of 1 or less)',
  fairnessSpreadBadge: 'Gap of {n} between most and least shown',
  chartMeanLabel: 'Avg {value}',
  chartTooltipTimes: 'Shown {count}x',
  chartTooltipFiles: '{files} files ({percent}%)',
  chartAriaLabel:
    'Display count distribution chart. {files} files, fewest {min}, most {max}, average {mean}',
  viewAsTable: 'View as table',
  tableColumnShare: 'Share',
  displayCountDistributionTitle: 'Display Count per Image',
  fairnessExplanation:
    'If the fair-shuffle algorithm is working correctly, every photo gets shown equally often.',
  resettingLabel: 'Resetting...',
  resetDisplayCountsButton: 'Reset Display Counts',
  confirmResetDisplayCounts: 'Reset the display count for every image?',

  // === Settings: Info ===
  appDescription: 'A slideshow app that shows 100,000+ photos fairly',
  versionLabel: 'Version: {version}',
  viewOnGitHub: 'View on GitHub',
  dangerZoneTitle: 'Danger Zone',
  dangerZoneDescription: "These actions can't be undone. Please double-check before continuing.",
  resetSettingsButton: 'Reset All Data',
  resettingSettingsLabel: 'Resetting...',
  confirmResetAllData:
    'Reset all data?\n\nThis deletes your settings, exclude rules, scanned file information, playlist, scan history, display history, and caches, and forgets the last folder. The pick destination setting returns to the default (the sss-picked folder in Pictures), and the Picks tab shows the files in that folder. If you had changed it, files in your previous pick destination are not deleted but no longer appear in the tab. Window position and size are kept.\n\nThis cannot be undone. The app will restart when finished.',
  resettingMessage: 'Resetting. The app will restart when finished.',
  resetErrorPrefix: 'Error: {detail}',
  errorDbResetFailed: 'Failed to reset the database',

  // === Language setting ===
  languageLabel: 'Language',
  languageAuto: 'Auto (system)',
  languageJa: '日本語',
  languageEn: 'English',
} as const;
