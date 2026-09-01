# Multi Timer

A lightweight dashboard for independent interval timers. The main page uses a compact three-column grid, while a separate floating overview can be dragged anywhere in the browser window. There is no framework, package install, build step, or server requirement.

## Use it

1. Open `index.html` in a modern browser.
2. Start any timer independently.
3. Use that card's **Alert now** button to count an alert immediately and give only that timer a full new interval.
4. Reset, edit, or remove one timer without disturbing the others.
5. Select **Add timer** whenever you need another timer.

Each timer has its own name, interval, repeat mode, sound, alert duration, color, and completion-color option. A finite timer stops after its chosen number of alerts. An **Until stopped** timer keeps repeating until its own Reset button is used.

On first use, a four-step guide introduces independent timers, the floating overview, keyboard shortcuts, and hover controls. Use the persistent **?** button in the header whenever you want to see the guide again.

Sound is enabled at full volume by default. The first click or key press anywhere in the timer prepares browser audio, so starting from a card, the overview, or a keyboard shortcut enables later alerts without opening the Sound menu. Browsers still require one real user interaction after a fresh page load; a hover by itself cannot grant audio permission. The sound picker includes three clear high-frequency cues: **Crystal Chirp**, **Triple Spark**, and **High Beacon**. Use the **Test** button in a timer's settings to compare them at the current volume.

Each gear opens that timer's settings in a modal. Click the backdrop, use **Done**, the close button, or press <kbd>Esc</kbd> to close it. Dragging from a field onto the backdrop does not accidentally close the modal.

Use **Earlier** and **Later** in a timer's settings to rearrange it. The saved order is shared by the dashboard and floating overview, and moving a running timer does not restart or rebase its countdown.

The floating overview shows running timers by default. Use the subtle **Show stopped** chevron at its bottom when you want idle or completed timers included; stopped rows appear muted but remain clickable. Click a row's large countdown area to **Start**, **Alert now**, or **Restart** according to its state. While a timer is active, its small corner reset icon stops it without restarting. Finite rows also show their completed/total alert count. Drag the overview's title bar to move it, use the small **−** and **+** controls for three balanced sizes, or focus the title bar and use the arrow keys. **Hide page** removes the dashboard while leaving the overview and alert-colored background active; **Show page** restores it. Its preferred position, chosen size, focused view, and stopped-timer visibility are remembered on this device. If a smaller browser window temporarily pushes the overview inward, enlarging the window returns it to its preferred position. The overview grows naturally with its timer rows and completion notice instead of adding an internal scrollbar. Regular alerts show the timer's name without an extra Stop control; use that timer's corner reset icon when needed. Completed finite timers leave a **Restart** prompt until restarted or dismissed.

Keyboard shortcuts work when a settings field is not active: press **Space** to hide or show the main page, tap **Alt** by itself to hide or show the floating overview, and press **1** through **9** to open settings for that timer position. When the main page is hidden, number-key settings appear by themselves without revealing the dashboard behind them.

Press **Tab** to toggle hover controls. While enabled, a subtle **Hover on** marker appears in the overview title bar. Rest the pointer over a timer's large countdown area until its loading bar fills to perform its normal Start, Alert now, or Restart action. The corner reset icon uses a slower fill before stopping its timer. Every hover action fires only once and requires leaving the control before it can be armed again. Hover controls work over a visible overview even when the browser window is not focused, subject to browser and operating-system pointer handling; they cannot receive the pointer through another window or from an inactive browser tab.

Alerts do not block the page. The matching card is highlighted and the page receives a strong timer-colored background tint, while the floating overview remains readable above it. A finite timer can keep its chosen page tint after completion until that timer is reset. Several completed timers can coexist; the most recently completed persistent timer controls the current page tint.

Preferences save automatically in `localStorage`, but active countdowns are intentionally not restored after a refresh. Existing settings from the older main-timer/reminder versions migrate into ordinary independent timer cards.

The scheduler uses monotonic timestamps instead of decrementing counters. If the browser delays a callback in the background, each overdue running timer emits at most one notification and receives a full new interval from delivery time. Missed-alert backlogs are not replayed.

## Defaults

- Focus session: stopped, 25 minutes, one alert, blue, Glass Ping
- Short break: stopped, 5 minutes, one alert, green, Soft Chime
- Water reminder: stopped, 30 minutes, repeats until stopped, cyan, Crystal Chirp
- Sound: on at 100% volume
- Visual alert duration: 4 seconds for Focus session, 3 seconds for Short break, 2.5 seconds for Water reminder
- Focus session completion color: stays visible until Reset

## Files

```text
index.html       Dashboard and reusable timer-card markup
css/styles.css   Three-column grid, modal, floating overview, and alert states
js/app.js        UI controller, scheduler, wake lock, and cleanup
js/timer.js      Independent timestamp-based timer engine
js/audio.js      Owner-scoped Web Audio notification sounds
js/storage.js    Defaults, preference migration, and localStorage
tests/           Timer, storage, and audio unit tests
```

The optional tests use Node's built-in test runner and need no dependencies:

```sh
node --test
```

## GitHub Pages

Push the repository to GitHub, then open **Settings → Pages**. Under **Build and deployment**, choose **Deploy from a branch**, select the main branch and `/(root)`, then save. GitHub's [publishing-source guide](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site) has the current steps.
