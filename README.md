# Interval Timer

A lightweight interval timer for repeated main alerts, with multiple named independent reminders (up to 50). It is a static web app: there is no framework, package install, build step, or server requirement.

## Use it

1. Open `index.html` in a modern browser.
2. Select **Start** to begin a new session.
3. Select **Alert Now** (or press <kbd>F</kbd>) to count an alert immediately and start a full new main interval from that moment.
4. Select **Reset** to stop the session, sounds, and alert visuals.

Use **Settings** to change preferences. Changes save automatically in `localStorage`; an active session is intentionally never restored after a refresh or reopening the page.

Main and reminder intervals use separate minute and second fields. While a session is running, the main schedule stays locked, but reminders remain live: you can add, remove, enable, disable, rename, or retime them. Adding, enabling, or retiming a reminder starts a full interval for that reminder from the moment of the change without moving the main deadline or any other reminder.

Clicking into a number selects its current value so the next number you type replaces it. Leaving an edited number blank restores its last saved value. Settings close only with **Done**, the close button, or <kbd>Esc</kbd>; dragging outside the dialog does not dismiss it.

The scheduler uses monotonic timestamps instead of decrementing a counter. If a browser delays a callback in the background, the app emits at most one overdue notification and starts a full new interval from the time that notification is delivered. It does not replay a missed-alert backlog.

## Defaults

- Main interval: 62 seconds
- Main alerts: 29
- Main sound: Glass Ping
- Main visual alert: 3 seconds of continuous red
- Sound: on at 100% volume
- One Item reminder: off (1 minute 30 seconds when enabled)
- Completion: one ascending chime and completion visual, then silence

## Files

```text
index.html       App markup and settings dialog
css/styles.css   Responsive design and alert states
js/app.js        UI, scheduling loop, wake lock, and cleanup
js/timer.js      Timestamp-based timer state engine
js/audio.js      Local Web Audio notification sounds
js/storage.js    Preference defaults and localStorage
tests/           Timer and preference unit tests
```

The optional tests use Node's built-in test runner and need no dependencies:

```sh
node --test
```

## GitHub Pages

Push the repository to GitHub, then open **Settings → Pages**. Under **Build and deployment**, choose **Deploy from a branch**, select the main branch and `/(root)`, then save. GitHub's [publishing-source guide](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site) has the current steps.
