# Multi Timer

A lightweight dashboard for independent interval timers. It is designed to sit in a narrow browser window at the right edge of a screen while another app or game occupies the rest. There is no framework, package install, build step, or server requirement.

## Use it

1. Open `index.html` in a modern browser.
2. Start any timer independently.
3. Use that card's **Alert now** button to count an alert immediately and give only that timer a full new interval.
4. Reset, disable, edit, or remove one timer without disturbing the others.
5. Select **Add timer** whenever you need another timer.

Each timer has its own name, interval, repeat mode, sound, alert duration, color, and completion-color option. A finite timer stops after its chosen number of alerts. An **Until stopped** timer keeps repeating until its own Reset button is used.

Alerts do not cover or block the page. The matching card is highlighted, the page receives a subtle color tint, and a compact alert tray identifies the timer. A finite timer can keep its chosen page tint after completion until that timer is reset. Several completed timers can coexist; the most recently completed persistent timer controls the current page tint.

Preferences save automatically in `localStorage`, but active countdowns are intentionally not restored after a refresh. Existing settings from the older main-timer/reminder versions migrate into ordinary independent timer cards.

The scheduler uses monotonic timestamps instead of decrementing counters. If the browser delays a callback in the background, each overdue running timer emits at most one notification and receives a full new interval from delivery time. Missed-alert backlogs are not replayed.

## Defaults

- Main timer: enabled, 1 minute 2 seconds, 29 alerts, red, Glass Ping
- Item reminder: disabled, 1 minute 30 seconds, repeats until stopped, amber, Double Tap
- Sound: on at 100% volume
- Visual alert duration: 3 seconds for Main timer, 1.4 seconds for Item reminder
- Main timer completion color: stays visible until Reset

## Files

```text
index.html       Dashboard and reusable timer-card markup
css/styles.css   Right-edge layout, timer cards, and alert states
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
