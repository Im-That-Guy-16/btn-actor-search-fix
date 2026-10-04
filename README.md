<p align="center">
  <img src="avatar.png" alt="Actor Search Fix" width="128" height="128">
</p>

<h1 align="center">BTN Actor Search Fix</h1>

<p align="center"><em>A drop-in repair for a broken actor search, powered by IMDb with a TVMaze fallback.</em></p>

<p align="center">
  <img alt="Type" src="https://img.shields.io/badge/Type-Userscript-6E40C9?style=for-the-badge">
  <img alt="Version" src="https://img.shields.io/badge/Version-1.0.3-38BDF8?style=for-the-badge">
  <img alt="JavaScript" src="https://img.shields.io/badge/JavaScript-Vanilla-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black">
  <img alt="Data" src="https://img.shields.io/badge/Data-IMDb%20%2B%20TVMaze-F5C518?style=for-the-badge&logo=imdb&logoColor=black">
  <img alt="Tampermonkey" src="https://img.shields.io/badge/Tampermonkey-Ready-00485B?style=for-the-badge&logo=tampermonkey&logoColor=white">
  <img alt="Licence" src="https://img.shields.io/badge/Licence-MIT-22C55E?style=for-the-badge">
</p>

---

## Overview

The site's actor search is broken server-side. The page still renders — search box,
empty results table, footer — but the backend never returns rows, so the feature is
effectively dead.

This userscript takes the page over. It resolves the typed name to a real person,
pulls their television credits from an external source, and rebuilds the results
table in place, styled to match the site's dark theme.

## How it works

| Stage | Source | Purpose |
|-------|--------|---------|
| Name → person | IMDb suggestion API | Resolve the typed name to one or more person IDs |
| Person → credits | IMDb GraphQL | Fetch the full filmography with title type, role, years and rating |
| Fallback credits | TVMaze cast credits | Used when IMDb returns a challenge page instead of JSON |

All calls are anonymous and read-only. No API key is required.

## Features

- **Zero configuration** — install it and the search page works.
- **Series and mini-series only**, deduped so one show credited twice is one row.
- **Large result cards** with poster art, role, years, rating and summary.
- **Quiet by default** — talk-show, "Self" and archive appearances collapse behind a toggle.
- **Handles ambiguity** — the best name match loads instantly, others are one click away.
- **Self-updating** via `@updateURL` / `@downloadURL`.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/).
2. Install [`btn-actor-search.user.js`](https://raw.githubusercontent.com/Im-That-Guy-16/btn-actor-search-fix/main/btn-actor-search.user.js).
3. Confirm the install, including the cross-origin `@connect` grants — these are required.
4. Open any actor search page.

> A userscript manager is required rather than a console paste, because the script
> makes cross-origin requests through `GM_xmlhttpRequest`.

## Known limitations

- Linking is **by show name**, since the site's series lookup takes no external ID.
  Exact titles resolve perfectly; a renamed or ambiguous title may land on a search list.
- The IMDb GraphQL endpoint is undocumented and may return a challenge page instead
  of JSON. The script falls back to TVMaze, whose credits can be less complete.

## Licence

Released under the [MIT Licence](LICENSE) © Im-That-Guy-16.
