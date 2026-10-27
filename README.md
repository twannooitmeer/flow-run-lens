# Flow Run Lens

A Chrome / Edge extension (Manifest V3) that shows cloud flow run details on flow lists in
**make.powerautomate.com** and **make.powerapps.com**.

- **A badge before every flow name**: the last 10 runs as coloured dots (oldest left), when the
  last run started, and how many of the last 25 runs failed.
- **Click a badge** for the latest 10 runs: status, start, duration, error code and message, and
  a link to each run.
- **A floating "Flow runs" button** lists every flow found on the page, failing flows first, and
  turns red when one is failing. "Refresh" clears the one-minute cache.

Works on *My flows*, *Shared with me*, solution views in Power Automate, and the solution
*Cloud flows* view in Power Apps (also when Power Automate embeds it in an iframe). A flow's own
details page already shows its runs, so it is left alone.

## Install (unpacked)

1. Edge: `edge://extensions`, Chrome: `chrome://extensions`.
2. Turn on **Developer mode**.
3. **Load unpacked** and pick this folder (the one with `manifest.json`).
4. Open or reload make.powerautomate.com or make.powerapps.com.

The toolbar popup says whether the extension has a session and how long it lasts.

## How it signs in

The extension has no app registration and asks for no credentials. While you use a maker
portal, the portal calls Microsoft's APIs with your own bearer token; the service worker reads
that `Authorization` header (`webRequest`) and reuses it for the run-history calls:

| Source | Endpoint | Token audience |
| --- | --- | --- |
| Power Platform API (primary) | `https://{env}.environment.api.powerplatform.com/powerautomate/flows/{id}/runs?api-version=1` | `https://api.powerplatform.com` |
| Flow API (fallback) | `https://api.flow.microsoft.com/providers/Microsoft.ProcessSimple/environments/{env}/flows/{id}/runs` | `https://service.flow.microsoft.com/` |

Safeguards:

- Only requests **initiated by** `make.powerautomate.com` or `make.powerapps.com` are read, and a
  token is kept only if its `aud` claim matches the API above.
- Tokens live in `chrome.storage.session`: in memory, cleared when the browser closes, not
  readable by content scripts. Nothing is logged or written to disk.
- A token is only ever sent back to the API family it was issued for; server-supplied `nextLink`
  URLs are checked against the same host pattern. A `401` drops the token.
- Messages are accepted only from the extension's own content scripts on the two portals, and
  environment and flow ids are validated before they reach a URL.
- All page output is built with `textContent`; API data is never parsed as HTML.
- "Forget session" in the popup clears the tokens immediately.

You see exactly the runs you could already see in the portal: the calls carry your permissions.

## Limits

- Run history covers what Power Automate retains (28 days).
- Power Apps solution grids have no flow links, so rows are matched by display name against the
  flows the API lists for you (personal and shared). A name used by two flows is skipped.
- The portals are single-page apps that change their markup; flow links (`/flows/{guid}`) and
  `role="row"` grids are what the extension relies on.

## Development

```bash
npm test
```

Unit tests cover the helpers (`src/lib/core.js`) and the service worker against a stubbed
`chrome.*` and `fetch` (fake tokens, synthetic runs). `test/fixture.html` exercises the content
script in a plain tab: serve the repo with `python tools/serve.py 5290` and open
`http://localhost:5290/test/fixture.html`.

`python tools/make-icons.py` regenerates the icons.

| File | Role |
| --- | --- |
| `src/background.js` | Token capture, API calls, caching, concurrency limit |
| `src/content.js` / `content.css` | Finds flow rows, renders badges, popover and panel |
| `src/lib/core.js` | Pure helpers shared by both and the tests |
| `src/popup.*` | Session status and "Forget session" |
