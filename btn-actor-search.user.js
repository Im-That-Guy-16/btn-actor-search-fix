// ==UserScript==
// @name         BTN Actor Search Fix (IMDb-powered)
// @namespace    https://github.com/Im-That-Guy-16/btn-actor-search-fix
// @version      1.0.3
// @description  Repairs BroadcasTheNet's broken actor search. Resolves the actor via IMDb, pulls TV credits from IMDb when available, falls back to TVMaze when IMDb blocks GraphQL, and links each show straight to BTN.
// @author       Im-That-Guy-16
// @homepageURL  https://github.com/Im-That-Guy-16/btn-actor-search-fix
// @supportURL   https://github.com/Im-That-Guy-16/btn-actor-search-fix/issues
// @downloadURL  https://raw.githubusercontent.com/Im-That-Guy-16/btn-actor-search-fix/main/btn-actor-search.user.js
// @updateURL    https://raw.githubusercontent.com/Im-That-Guy-16/btn-actor-search-fix/main/btn-actor-search.user.js
// @icon         https://raw.githubusercontent.com/Im-That-Guy-16/btn-actor-search-fix/main/avatar.png
// @license      MIT
// @match        https://broadcasthe.net/actor.php*
// @match        https://www.broadcasthe.net/actor.php*
// @run-at       document-end
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      v3.sg.media-imdb.com
// @connect      v2.sg.media-imdb.com
// @connect      api.graphql.imdb.com
// @connect      api.tvmaze.com
// @connect      imdb.com
// @connect      media-amazon.com
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   *  Config
   * ------------------------------------------------------------------ */
  const IMDB_SUGGEST = 'https://v3.sg.media-imdb.com/suggestion/x/';
  const IMDB_GRAPHQL = 'https://api.graphql.imdb.com/';
  const TVMAZE_API = 'https://api.tvmaze.com/';
  // IMDb title types we treat as "TV shows" for the main list.
  const TV_TYPES = new Set(['tvSeries', 'tvMiniSeries']);
  // Credit categories hidden by default (guest/self/archive appearances).
  const SOFT_HIDE = new Set(['Self', 'Archive Footage', 'Archive Sound']);

  /* ------------------------------------------------------------------ *
   *  Cross-origin HTTP helper (works on GM3, GM4 and, as a last resort,
   *  plain fetch — though fetch will be CORS-blocked for IMDb).
   * ------------------------------------------------------------------ */
  const gmRequest =
    (typeof GM_xmlhttpRequest !== 'undefined' && GM_xmlhttpRequest) ||
    (typeof GM !== 'undefined' && GM && GM.xmlHttpRequest) ||
    null;

  function httpJSON(opts) {
    return new Promise((resolve, reject) => {
      const { url, method = 'GET', headers = {}, body = null } = opts;
      if (gmRequest) {
        gmRequest({
          method,
          url,
          headers,
          data: body,
          onload: (r) => {
            const contentType = String(
              (r.responseHeaders || '').match(/^content-type:\s*([^\r\n]+)/im)?.[1] ||
                ''
            );
            if (r.status < 200 || r.status >= 300) {
              reject(
                new Error(
                  'HTTP ' +
                    r.status +
                    ' from ' +
                    url +
                    (contentType ? ' (' + contentType + ')' : '')
                )
              );
              return;
            }
            if (contentType && !/json/i.test(contentType)) {
              reject(new Error('Non-JSON response from ' + url + ' (' + contentType + ')'));
              return;
            }
            try {
              resolve(JSON.parse(r.responseText));
            } catch (e) {
              reject(new Error('Bad JSON from ' + url));
            }
          },
          onerror: () => reject(new Error('Request failed: ' + url)),
          ontimeout: () => reject(new Error('Request timed out: ' + url)),
        });
      } else {
        // Fallback — will only succeed if CORS happens to allow it.
        fetch(url, { method, headers, body })
          .then((r) => {
            const contentType = r.headers.get('content-type') || '';
            if (!r.ok) {
              throw new Error(
                'HTTP ' +
                  r.status +
                  ' from ' +
                  url +
                  (contentType ? ' (' + contentType + ')' : '')
              );
            }
            if (contentType && !/json/i.test(contentType)) {
              throw new Error('Non-JSON response from ' + url + ' (' + contentType + ')');
            }
            return r.json();
          })
          .then(resolve)
          .catch(reject);
      }
    });
  }

  /* ------------------------------------------------------------------ *
   *  IMDb API calls
   * ------------------------------------------------------------------ */
  async function resolveActors(query) {
    const url =
      IMDB_SUGGEST + encodeURIComponent(query.trim()) + '.json?includeVideos=0';
    const data = await httpJSON({ url });
    return (data.d || [])
      .filter((x) => String(x.id).startsWith('nm'))
      .map((x) => ({
        id: x.id,
        name: x.l,
        blurb: x.s || '',
        rank: x.rank || 999999,
        image: x.i && x.i.imageUrl ? x.i.imageUrl : null,
      }));
  }

  const CREDITS_QUERY = `query Credits($id: ID!, $after: ID) {
    name(id: $id) {
      nameText { text }
      primaryImage { url }
      credits(first: 250, after: $after) {
        total
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            category { text }
            title {
              id
              titleText { text }
              titleType { id text }
              primaryImage { url }
              releaseYear { year endYear }
              ratingsSummary { aggregateRating voteCount }
            }
          }
        }
      }
    }
  }`;

  async function fetchCredits(nconst) {
    let after = null;
    let guard = 0;
    let person = null;
    const edges = [];
    do {
      const res = await httpJSON({
        url: IMDB_GRAPHQL,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: CREDITS_QUERY,
          variables: { id: nconst, after },
        }),
      });
      if (res.errors && res.errors.length) {
        throw new Error(res.errors[0].message || 'IMDb GraphQL error');
      }
      const name = res.data && res.data.name;
      if (!name) throw new Error('No data for ' + nconst);
      if (!person) {
        person = {
          name: name.nameText ? name.nameText.text : '',
          image: name.primaryImage ? name.primaryImage.url : null,
        };
      }
      const c = name.credits || {};
      (c.edges || []).forEach((e) => edges.push(e.node));
      const pi = c.pageInfo || {};
      after = pi.hasNextPage ? pi.endCursor : null;
    } while (after && ++guard < 20);

    return { person, credits: edges };
  }

  async function fetchTvMazeCredits(personName, fallbackImage) {
    const matches = await httpJSON({
      url: TVMAZE_API + 'search/people?q=' + encodeURIComponent(personName),
    });
    const people = Array.isArray(matches) ? matches : [];
    const chosen =
      people.find(
        (m) =>
          m.person &&
          m.person.name &&
          m.person.name.toLowerCase() === personName.toLowerCase()
      ) ||
      people[0];
    if (!chosen || !chosen.person) throw new Error('No TVMaze person match for ' + personName);

    const credits = await httpJSON({
      url: TVMAZE_API + 'people/' + chosen.person.id + '/castcredits?embed=show',
    });
    const person = {
      name: chosen.person.name || personName,
      image:
        (chosen.person.image &&
          (chosen.person.image.original || chosen.person.image.medium)) ||
        fallbackImage ||
        null,
    };

    return {
      person,
      rows: buildTvMazeShowList(Array.isArray(credits) ? credits : []),
    };
  }

  /* ------------------------------------------------------------------ *
   *  Shape the credits into a deduped, sorted list of TV shows
   * ------------------------------------------------------------------ */
  function buildShowList(credits) {
    const byId = new Map();
    for (const node of credits) {
      const t = node.title;
      if (!t || !t.titleType) continue;
      if (!TV_TYPES.has(t.titleType.id)) continue;
      const cat = node.category ? node.category.text : '';
      let row = byId.get(t.id);
      if (!row) {
        row = {
          id: t.id,
          title: t.titleText ? t.titleText.text : '(untitled)',
          typeId: t.titleType.id,
          typeText: t.titleType.text,
          yearStart: t.releaseYear ? t.releaseYear.year : null,
          yearEnd: t.releaseYear ? t.releaseYear.endYear : null,
          rating:
            t.ratingsSummary && t.ratingsSummary.aggregateRating != null
              ? t.ratingsSummary.aggregateRating
              : null,
          image: t.primaryImage ? t.primaryImage.url : null,
          genres: [],
          status: '',
          network: '',
          summary: '',
          votes:
            t.ratingsSummary && t.ratingsSummary.voteCount != null
              ? t.ratingsSummary.voteCount
              : null,
          roles: new Set(),
        };
        byId.set(t.id, row);
      }
      if (cat) row.roles.add(cat);
    }
    const rows = [...byId.values()].map((r) => ({
      ...r,
      roles: [...r.roles],
      soft: [...r.roles].every((c) => SOFT_HIDE.has(c)),
    }));
    // Sort: newest first, then by title.
    rows.sort((a, b) => {
      const ya = a.yearStart || 0;
      const yb = b.yearStart || 0;
      if (yb !== ya) return yb - ya;
      return a.title.localeCompare(b.title);
    });
    return rows;
  }

  function buildTvMazeShowList(credits) {
    const byId = new Map();
    for (const credit of credits) {
      const show = credit._embedded && credit._embedded.show;
      if (!show) continue;
      const id = String(show.id);
      let row = byId.get(id);
      if (!row) {
        const premiered = show.premiered ? Number(show.premiered.slice(0, 4)) : null;
        const ended = show.ended ? Number(show.ended.slice(0, 4)) : null;
        row = {
          id: show.externals && show.externals.imdb ? show.externals.imdb : 'tvmaze-' + id,
          title: show.name || '(untitled)',
          typeId: 'tvSeries',
          typeText: show.type || 'Series',
          yearStart: Number.isFinite(premiered) ? premiered : null,
          yearEnd: Number.isFinite(ended) ? ended : null,
          rating: show.rating && show.rating.average != null ? show.rating.average : null,
          image:
            show.image && (show.image.original || show.image.medium)
              ? show.image.original || show.image.medium
              : null,
          genres: show.genres || [],
          status: show.status || '',
          network:
            (show.network && show.network.name) ||
            (show.webChannel && show.webChannel.name) ||
            '',
          summary: stripHTML(show.summary || ''),
          votes: null,
          roles: new Set(),
          soft: false,
          tvmazeUrl: show.url || null,
        };
        byId.set(id, row);
      }
      const character = credit._links && credit._links.character;
      if (character && character.name) row.roles.add(character.name);
      else row.roles.add(credit.voice ? 'Voice' : 'Cast');
    }
    const rows = [...byId.values()].map((r) => ({
      ...r,
      roles: [...r.roles],
    }));
    rows.sort((a, b) => {
      const ya = a.yearStart || 0;
      const yb = b.yearStart || 0;
      if (yb !== ya) return yb - ya;
      return a.title.localeCompare(b.title);
    });
    return rows;
  }

  /* ------------------------------------------------------------------ *
   *  DOM helpers
   * ------------------------------------------------------------------ */
  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (k === 'style') n.style.cssText = attrs[k];
        else if (k === 'html') n.innerHTML = attrs[k];
        else if (k === 'text') n.textContent = attrs[k];
        else n.setAttribute(k, attrs[k]);
      }
    }
    (children || []).forEach((c) => {
      if (c == null) return;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return n;
  }

  function stripHTML(html) {
    const div = document.createElement('div');
    div.innerHTML = html;
    return (div.textContent || div.innerText || '').trim();
  }

  function btnSeriesUrl(title) {
    const p = new URLSearchParams({ name: title });
    return 'series.php?' + p.toString();
  }
  function imdbTitleUrl(id) {
    return 'https://www.imdb.com/title/' + id + '/';
  }
  function externalTitleUrl(row) {
    return /^tt\d+$/.test(row.id) ? imdbTitleUrl(row.id) : row.tvmazeUrl;
  }
  function externalTitleLabel(row) {
    return /^tt\d+$/.test(row.id) ? 'IMDb' : 'TVMaze';
  }

  function yearLabel(r) {
    if (!r.yearStart) return '';
    if (r.yearEnd && r.yearEnd !== r.yearStart)
      return r.yearStart + '–' + r.yearEnd;
    if (
      r.typeId === 'tvSeries' &&
      !r.yearEnd &&
      r.yearStart >= new Date().getFullYear() - 1
    )
      return r.yearStart + '–';
    return String(r.yearStart);
  }

  /* ------------------------------------------------------------------ *
   *  Rendering
   * ------------------------------------------------------------------ */
  const STYLE_ID = 'imdb-actor-fix-style';
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    document.head.appendChild(
      el('style', {
        id: STYLE_ID,
        text: `
        .iaf-box{margin-top:12px}
        .iaf-head{display:flex;gap:14px;align-items:center;margin:6px 0 12px}
        .iaf-head img{width:54px;height:78px;object-fit:cover;border-radius:4px;flex:0 0 auto;background:#222}
        .iaf-head .iaf-name{font-size:18px;font-weight:600}
        .iaf-head .iaf-sub{opacity:.7;font-size:12px;margin-top:2px}
        .iaf-matches{font-size:12px;opacity:.85;margin:4px 0 10px}
        .iaf-matches a{margin-right:10px;cursor:pointer}
        .iaf-toolbar{display:flex;gap:16px;align-items:center;font-size:12px;margin:6px 0 10px;opacity:.9}
        .iaf-toolbar label{cursor:pointer}
        .iaf-results{display:grid;gap:14px;margin-top:10px}
        .iaf-card{position:relative;display:grid;grid-template-columns:116px minmax(0,1fr) auto;gap:18px;align-items:stretch;min-height:168px;padding:14px;border:1px solid rgba(138,153,175,.22);border-radius:7px;background:linear-gradient(115deg,rgba(31,40,51,.98),rgba(19,25,34,.98));box-shadow:0 1px 0 rgba(255,255,255,.03) inset,0 12px 28px rgba(0,0,0,.18);overflow:hidden}
        .iaf-card:before{content:"";position:absolute;inset:0;background:linear-gradient(90deg,rgba(255,255,255,.045),rgba(255,255,255,0) 32%);pointer-events:none}
        .iaf-card.iaf-soft{opacity:.62}
        .iaf-poster{position:relative;z-index:1;width:116px;min-height:154px;border-radius:6px;overflow:hidden;background:#101720;border:1px solid rgba(255,255,255,.08);box-shadow:0 8px 18px rgba(0,0,0,.25)}
        .iaf-poster img{display:block;width:100%;height:100%;object-fit:cover}
        .iaf-poster-empty{display:grid;place-items:center;color:#aab4c3;font-size:36px;font-weight:700;background:linear-gradient(145deg,#253243,#111923)}
        .iaf-content{position:relative;z-index:1;min-width:0;display:flex;flex-direction:column;gap:9px}
        .iaf-titleline{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap}
        .iaf-title{font-size:22px;font-weight:700;line-height:1.18;color:#d8dee8;text-decoration:none}
        .iaf-title:hover{text-decoration:underline}
        .iaf-badges{display:flex;gap:7px;flex-wrap:wrap}
        .iaf-badge{display:inline-flex;align-items:center;min-height:22px;padding:2px 8px;border-radius:4px;border:1px solid rgba(157,172,193,.24);background:rgba(8,13,20,.36);color:#aeb8c8;font-size:11px;font-weight:700;letter-spacing:0;text-transform:uppercase}
        .iaf-cardmeta{display:flex;gap:9px;flex-wrap:wrap;color:#9ea8b8;font-size:12px}
        .iaf-cardmeta span{display:inline-flex;align-items:center;gap:4px}
        .iaf-roleline{color:#c3cbd7;font-size:13px}
        .iaf-roleline strong{color:#e0e6ee}
        .iaf-summary{max-width:920px;color:#a6b0bf;font-size:12px;line-height:1.45}
        .iaf-actions{position:relative;z-index:1;display:flex;flex-direction:column;gap:8px;justify-content:center;min-width:124px}
        .iaf-actions a{display:flex;align-items:center;justify-content:center;min-height:32px;padding:0 12px;border-radius:5px;border:1px solid rgba(152,168,190,.25);background:rgba(9,14,21,.52);color:#d8dee8;text-decoration:none;font-size:12px;font-weight:700}
        .iaf-actions a:first-child{background:rgba(60,89,119,.48);border-color:rgba(139,172,203,.42)}
        .iaf-actions a:hover{background:rgba(83,111,143,.58);text-decoration:none}
        .iaf-rating{white-space:nowrap;font-variant-numeric:tabular-nums}
        .iaf-note{opacity:.7;font-size:12px;margin:8px 0}
        .iaf-err{color:#ff8686;margin:8px 0}
        .iaf-spin{opacity:.8;margin:10px 0}
        @media (max-width:720px){
          .iaf-card{grid-template-columns:82px minmax(0,1fr);gap:12px;padding:12px}
          .iaf-poster{width:82px;min-height:116px}
          .iaf-title{font-size:17px}
          .iaf-actions{grid-column:1 / -1;flex-direction:row;justify-content:flex-start;min-width:0;flex-wrap:wrap}
          .iaf-actions a{min-width:92px}
        }
      `,
      })
    );
  }

  // Find where to render: reuse the broken results table's container.
  function getMount() {
    const tbl = document.getElementById('torrent_table');
    let host = tbl ? tbl.parentNode : null;
    if (tbl) tbl.style.display = 'none'; // hide the empty broken table
    if (!host) {
      // Fallback: append after the search form's box.
      const form = document.querySelector('form[action="actor.php"]');
      host =
        (form && (form.closest('.box') || form.parentNode)) || document.body;
    }
    let mount = document.getElementById('iaf-mount');
    if (!mount) {
      mount = el('div', { id: 'iaf-mount', class: 'iaf-box' });
      host.appendChild(mount);
    }
    return mount;
  }

  function renderStatus(mount, msg, cls) {
    mount.innerHTML = '';
    mount.appendChild(el('div', { class: cls || 'iaf-spin', text: msg }));
  }

  let currentRows = [];
  let currentSource = 'IMDb';
  let showSoft = false;

  function renderShows(mount, person, actors, activeId) {
    mount.innerHTML = '';

    // Header: photo + name.
    const head = el('div', { class: 'iaf-head' }, [
      person.image
        ? el('img', { src: person.image, alt: person.name, loading: 'lazy' })
        : null,
      el('div', {}, [
        el('div', { class: 'iaf-name', text: person.name || 'Actor' }),
        el('div', {
          class: 'iaf-sub',
          text:
            currentRows.length +
            ' TV title' +
            (currentRows.length === 1 ? '' : 's') +
            ' found via ' +
            currentSource,
        }),
      ]),
    ]);
    mount.appendChild(head);

    // Other matches switcher.
    const others = actors.filter((a) => a.id !== activeId);
    if (others.length) {
      const bar = el('div', { class: 'iaf-matches' }, [
        el('span', { text: 'Other matches: ' }),
      ]);
      others.slice(0, 6).forEach((a) => {
        const link = el('a', { href: 'javascript:void 0', text: a.name });
        link.addEventListener('click', (e) => {
          e.preventDefault();
          location.hash = a.id;
          run();
        });
        bar.appendChild(link);
      });
      mount.appendChild(bar);
    }

    // Toolbar: toggle soft-hidden appearances.
    const softCount = currentRows.filter((r) => r.soft).length;
    if (softCount) {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = showSoft;
      cb.addEventListener('change', () => {
        showSoft = cb.checked;
        drawCards(mount);
      });
      const lbl = el('label', {}, [
        cb,
        ' Show ' + softCount + ' talk-show / archive appearance' +
          (softCount === 1 ? '' : 's'),
      ]);
      mount.appendChild(el('div', { class: 'iaf-toolbar' }, [lbl]));
    }

    const results = el('div', { id: 'iaf-results', class: 'iaf-results' });
    mount.appendChild(results);
    drawCards(mount);
  }

  function drawCards(mount) {
    const wrap = mount.querySelector('#iaf-results');
    if (!wrap) return;
    wrap.innerHTML = '';

    const rows = currentRows.filter((r) => showSoft || !r.soft);
    if (!rows.length) {
      wrap.appendChild(
        el('div', {
          class: 'iaf-note',
          text: 'No TV series or mini-series found for this person.',
        })
      );
      return;
    }

    rows.forEach((r) => {
      const typeLabel = r.typeId === 'tvMiniSeries' ? 'Mini-series' : 'Series';
      const meta = [
        yearLabel(r),
        r.status,
        r.network,
        r.genres && r.genres.length ? r.genres.slice(0, 3).join(' / ') : '',
      ].filter(Boolean);
      const links = [
        el('a', { href: btnSeriesUrl(r.title), text: 'BTN Series' }),
        externalTitleUrl(r)
          ? el('a', {
              href: externalTitleUrl(r),
              target: '_blank',
              rel: 'noopener',
              text: externalTitleLabel(r),
            })
          : null,
      ];
      const card = el('article', { class: 'iaf-card' + (r.soft ? ' iaf-soft' : '') }, [
        r.image
          ? el('div', { class: 'iaf-poster' }, [
              el('img', { src: r.image, alt: r.title, loading: 'lazy' }),
            ])
          : el('div', {
              class: 'iaf-poster iaf-poster-empty',
              text: r.title.slice(0, 1).toUpperCase(),
            }),
        el('div', { class: 'iaf-content' }, [
          el('div', { class: 'iaf-titleline' }, [
            el('a', {
              class: 'iaf-title',
              href: btnSeriesUrl(r.title),
              title: 'Open BTN series page for “' + r.title + '”',
              text: r.title,
            }),
            el('div', { class: 'iaf-badges' }, [
              el('span', { class: 'iaf-badge', text: typeLabel }),
              r.rating != null
                ? el('span', {
                    class: 'iaf-badge iaf-rating',
                    text: '★ ' + r.rating.toFixed(1),
                  })
                : null,
            ]),
          ]),
          meta.length
            ? el(
                'div',
                { class: 'iaf-cardmeta' },
                meta.map((m) => el('span', { text: m }))
              )
            : null,
          r.roles.length
            ? el('div', { class: 'iaf-roleline' }, [
                el('strong', { text: 'Role: ' }),
                r.roles.join(', '),
              ])
            : null,
          r.summary ? el('div', { class: 'iaf-summary', text: r.summary }) : null,
        ]),
        el('nav', { class: 'iaf-actions' }, links),
      ]);
      wrap.appendChild(card);
    });
  }

  /* ------------------------------------------------------------------ *
   *  Orchestration
   * ------------------------------------------------------------------ */
  function getQueryName() {
    const p = new URLSearchParams(location.search);
    return (p.get('name') || '').trim();
  }
  function getForcedNconst() {
    const h = (location.hash || '').replace(/^#/, '');
    return /^nm\d+$/.test(h) ? h : null;
  }

  async function run() {
    const name = getQueryName();
    if (!name) return; // Just the empty search form — leave it be.

    injectStyles();
    const mount = getMount();
    renderStatus(mount, 'Searching IMDb for “' + name + '”…');

    try {
      const actors = await resolveActors(name);
      if (!actors.length) {
        renderStatus(
          mount,
          'No actor named “' + name + '” found on IMDb.',
          'iaf-note'
        );
        return;
      }
      actors.sort((a, b) => a.rank - b.rank);

      const forced = getForcedNconst();
      const chosen =
        (forced && actors.find((a) => a.id === forced)) || actors[0];

      renderStatus(
        mount,
        'Loading TV credits for ' + chosen.name + '…'
      );

      let person;
      try {
        const imdb = await fetchCredits(chosen.id);
        person = imdb.person;
        currentRows = buildShowList(imdb.credits);
        currentSource = 'IMDb';
      } catch (imdbErr) {
        // IMDb's GraphQL endpoint can return an HTML 403 challenge. TVMaze keeps
        // the actor search useful without asking the user for an IMDb session.
        console.warn('[BTN Actor Search] IMDb credits failed, trying TVMaze', imdbErr);
        const tvmaze = await fetchTvMazeCredits(chosen.name, chosen.image);
        person = tvmaze.person;
        currentRows = tvmaze.rows;
        currentSource = 'TVMaze';
      }
      // Prefer the IMDb photo, fall back to the suggestion thumbnail.
      if (!person.image && chosen.image) person.image = chosen.image;
      if (!person.name) person.name = chosen.name;

      renderShows(mount, person, actors, chosen.id);
    } catch (err) {
      renderStatus(
        mount,
        'Could not load results: ' + (err && err.message ? err.message : err),
        'iaf-err'
      );
      // eslint-disable-next-line no-console
      console.error('[BTN Actor Search]', err);
    }
  }

  run();
})();
