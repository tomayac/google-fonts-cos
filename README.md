# Google Fonts × Cross-Origin Storage

A proof-of-concept that serves Google Fonts from the browser's
[Cross-Origin Storage (COS)](https://github.com/wicg/cross-origin-storage) API
instead of downloading them from `fonts.googleapis.com` on every site visit.

Once a font file has been fetched by _any_ site that uses this loader,
subsequent visits from _any other_ site that also uses this loader get the file
straight from the local COS cache — no network round-trip, no Google server
involved.

## Two loader variants

Two variants of the loader are provided. Both share the same HTML structure — a
`<noscript data-cos-fonts>` block with the original Google Fonts `<link>` tags
as a no-JS / no-COS fallback, and a small inline `<script>` — but they differ
in how they map font files to their SHA-256 hashes.

### Static loader (`cos-loader-static.js`)

A build step (the generator) fetches every referenced font file, computes its
SHA-256 hash, and bakes a `stem → hash` map directly into the minified script.
COS lookups on every subsequent page load use that map without touching the
network.

**Pros**
- Fastest possible warm start: the hash is known before any I/O begins, so a
  single COS lookup is all that stands between the user and the font.
- No SHA-256 computation at runtime — the hash is a string literal.
- The CSS descriptor list (`@font-face` rules) is also cached in `localStorage`
  indefinitely, eliminating the CSS fetch on all but the very first visit.

**Cons**
- The embedded hash map is a snapshot taken at build time. If Google updates a
  font file the baked-in hashes become stale and the page will silently keep
  serving the old version from COS (or re-fetch the old URL from Google).
- Picking up an update requires running the generator again and redeploying.

### Dynamic loader (`cos-loader-dynamic.js`)

No hash map is baked in. Instead, font file hashes are computed on first use
and cached in `localStorage` keyed by the full versioned URL
(e.g. `cos_fh:https://fonts.gstatic.com/s/inter/v13/…`). The Google Fonts CSS
is re-fetched according to the `Cache-Control` headers in Google's own response
(`max-age=86400, stale-while-revalidate=604800` as of writing), so no TTL is
hardcoded. Version-bumped font URLs (e.g. `/v13/` → `/v14/`) are discovered
automatically when the CSS is refreshed.

**Pros**
- Self-updating: a font revision is picked up within one `max-age` window plus
  one page load, with no rebuild or redeploy needed.
- Font file URLs from Google Fonts already embed a version string that changes
  with every revision, so a changed URL means a different `localStorage` key —
  the new version is fetched and re-hashed automatically.

**Cons**
- The first-ever visit (cold start) must fetch and hash every font file before
  it can be registered.
- A stale CSS cache means the current visit may use slightly old `@font-face`
  descriptors (updated versions land on the _next_ visit).

---

## Algorithm walkthrough

Google Fonts font file URLs carry a version segment that changes whenever
Google revises a font:

```
https://fonts.gstatic.com/s/inter/v13/<content-hash>.woff2
                                  ^^^
```

Both loaders use this property. The key difference is **when** the hash of
each file is known: the static loader knows it at build time; the dynamic
loader discovers it at runtime and caches it.

All font data is passed as an `ArrayBuffer` directly to the
[CSS Font Loading API](https://developer.mozilla.org/en-US/docs/Web/API/FontFace)
— no `blob:` URL is created, so both loaders work under strict Content Security
Policies that do not include `font-src blob:`.

### Static loader

#### Cold start — first ever visit

1. Parse `<noscript data-cos-fonts>` → extract Google Fonts CSS URL(s).
2. `localStorage` miss for `cos_font_css_v1:{url}` → fetch CSS from
   `fonts.googleapis.com`, parse `@font-face` rules, cache result
   (no TTL — Google Fonts CSS for a given query is stable).
3. For each font face **in parallel**:
   a. Look up hash in the baked-in stem→hash map.
   b. Query COS with that hash → miss.
   c. Fetch font file from `fonts.gstatic.com`.
   d. Store in COS (fire-and-forget); register `FontFace`.

#### Warm start — subsequent visits

1. Parse noscript → get CSS URL.
2. `localStorage` hit for CSS descriptors → return immediately, no network.
3. For each font face **in parallel**:
   a. Look up hash in the baked-in map.
   b. Query COS with that hash → hit → return file.
   c. Register `FontFace`. **No network requests.**

#### A font file is updated by Google

Google increments the version segment and changes the file content
(e.g. `/v13/` → `/v14/`). The CSS served by `fonts.googleapis.com` changes
accordingly, but:

- The CSS is cached in `localStorage` with no TTL → the loader keeps reading
  the old `@font-face` rules with the old URL.
- The old URL still resolves on Google's CDN (old versions remain accessible).
- The baked-in hash still matches the old content → COS hit → **the old font
  version is rendered indefinitely**.

To pick up the update: run the generator against the current Google Fonts CSS,
then redeploy the page.

---

### Dynamic loader

#### Cold start — first ever visit

1. Parse `<noscript data-cos-fonts>` → extract Google Fonts CSS URL(s).
2. `localStorage` miss for `cos_font_css_dyn:{url}` → fetch CSS, parse
   `@font-face` rules, cache with a timestamp.
3. For each font face **in parallel**:
   a. `localStorage` miss for `cos_fh:{versioned-url}` → no hash known yet.
   b. Fetch font file from `fonts.gstatic.com`; return buffer immediately.
   c. **Fire-and-forget:** compute SHA-256 → write hash to `localStorage` →
      store file in COS for cross-origin reuse.
   d. Register `FontFace` from the in-memory buffer while (c) runs in
      the background.

#### Warm start — subsequent visits

1. Parse noscript → get CSS URL.
2. `localStorage` hit, age < `max-age` → return faces immediately, no network.
3. For each font face **in parallel**:
   a. `localStorage` hit for `cos_fh:{versioned-url}` → hash known.
   b. Query COS with that hash → hit → return file.
   c. Register `FontFace`. **No network requests.**

#### A font file is updated by Google

Google increments the version segment (e.g. `/v13/` → `/v14/`), changing the
URL in the Google Fonts CSS.

- **CSS cache still fresh** (age < `max-age`): cached `@font-face` descriptors
  still reference the old URL → old font file, served from COS or Google.
- **CSS cache stale** (`max-age` ≤ age < `max-age + stale-while-revalidate`):
  old faces are returned immediately so font loading starts now; a background
  fetch updates `localStorage` with the new descriptors for the next visit.
- **CSS cache expired** (age ≥ `max-age + stale-while-revalidate`): new CSS is
  fetched synchronously before font loading begins; new descriptors cached.
- **Next visit after CSS refresh**: the new versioned URL has no `localStorage`
  entry → cold path for that file → font fetched from Google, hash cached,
  file stored in COS.
- **Visit after that**: COS hit on the new hash → no network.

The update lands within one `max-age + stale-while-revalidate` window plus
2 page loads of Google publishing it, with no rebuild or redeploy required.
For Google Fonts' current headers (`max-age=86400, stale-while-revalidate=604800`)
that is at most **8 days + 2 page loads**.

---

## Live demo

Two independently hosted origins both use the same loader and the same
pre-computed hashes. Load either page first to warm the COS cache, then load the
other — the fonts on the second page are served entirely from COS storage.

- **GitHub Pages:** <https://tomayac.github.io/google-fonts-cos/>
- **Independent origin:** <https://google-fonts-cos-tomayac.yoyo.codes/>

## Try it

### Prerequisites

Cross-Origin Storage is a proposed browser API, not yet shipped in any stable
browser. To try it today, install the Chrome extension that polyfills the API:

**[Cross-Origin Storage — Chrome Web Store](https://chromewebstore.google.com/detail/cross-origin-storage/denpnpcgjgikjpoglpjefakmdcbmlgih)**

Source: <https://github.com/web-ai-community/cross-origin-storage-extension>

### Steps

1. Install the extension from the Chrome Web Store link above.
2. Open the demo index: <https://tomayac.github.io/google-fonts-cos/> and
   choose a variant. The page loads the fonts from Google Fonts and stores them
   in COS.
3. Click the extension icon to inspect which font files were stored and from
   which origin.
4. Open the second demo origin: <https://google-fonts-cos-tomayac.yoyo.codes/>
   This time the fonts are served from COS — no request reaches
   `fonts.gstatic.com`.

You can open the two origins in either order; the one loaded second always
benefits from the COS cache populated by the first.

## Generator

The hosted generator at
**<https://tomayac.github.io/google-fonts-cos/generator.html>** turns any
Google Fonts embed snippet into a ready-to-paste COS block.

**Supports both embed variants:**

```html
<!-- <link> variant -->
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link
  href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap"
  rel="stylesheet"
/>
```

```css
/* @import variant */
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap');
```

Select **Static** to pre-compute hashes (requires a rebuild on font updates) or
**Dynamic** to skip hashing and rely on runtime discovery (no rebuild needed).

**What the static path does:**

1. Parses the embed code and extracts the Google Fonts CSS URL(s).
2. Fetches every referenced font file and computes its SHA-256 content hash.
3. Minifies `cos-loader-static.js` with [esbuild](https://esbuild.github.io/) (running
   entirely in the browser via esbuild-wasm) and bakes the hash map in.
4. Outputs a ready-to-paste `<head>` snippet.

**What the dynamic path does:**

1. Parses the embed code and extracts the Google Fonts CSS URL(s).
2. Minifies `cos-loader-dynamic.js` as-is — no font fetching, no hashing.
3. Outputs the same snippet format; hashes are computed at runtime on first use.

No server involved — everything runs in the browser.

### Building the demo pages locally

The Puppeteer build script opens `generator.html` in headless Chrome, runs both
variants, and injects the output into the two demo pages:

```bash
npm install
npm run build   # writes index-static.html and index-dynamic.html
```

## Repository layout

| File                    | Purpose                                                              |
| ----------------------- | -------------------------------------------------------------------- |
| `cos-loader-static.js`         | Static loader source (non-minified, with `#build-remove` markers)    |
| `cos-loader-dynamic.js` | Dynamic loader source (non-minified, no hash map)                    |
| `generator.html`        | Browser-based generator; produces static or dynamic embed code       |
| `build.js`              | Puppeteer script that regenerates `index-static.html` and `index-dynamic.html` |
| `index.html`            | Landing page linking to both demo variants                           |
| `index-static.html`     | Demo page — static loader (pre-computed hashes, build-generated)     |
| `index-dynamic.html`    | Demo page — dynamic loader (runtime hashing, build-generated)        |

## Background

Cross-Origin Storage is a proposed web platform API being incubated in the WICG.
Read the explainer for the full motivation and design:

<https://github.com/wicg/cross-origin-storage>

## License

Apache 2.0
