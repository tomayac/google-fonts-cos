(async () => {
  // Dynamic COS loader — no pre-computed hash map.
  //
  // Google Fonts font file URLs embed a version string (e.g. /v39/).
  // When Google updates a font the version increments and the URL changes.
  // A changed URL has no localStorage entry, so it is fetched and re-hashed
  // automatically — no explicit "did the content change?" check is needed.
  //
  // CSS freshness is governed by the Cache-Control headers in Google's own
  // response (max-age + stale-while-revalidate), stored alongside the parsed
  // faces so no TTL is hardcoded here.

  const parser = new DOMParser();

  const cssUrls = [...new Set(
    [...document.querySelectorAll('noscript[data-cos-fonts]')]
      .flatMap((ns) => [...parser.parseFromString(ns.innerHTML, 'text/html').querySelectorAll('link[rel="stylesheet"]')])
      .map((l) => l.href)
      .filter((h) => {
        try { return new URL(h).hostname === 'fonts.googleapis.com'; } catch { return false; }
      })
  )];

  if (!cssUrls.length) return;

  const fallbackToGoogleFonts = () => {
    for (const href of cssUrls)
      document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href }));
  };

  // Progressive enhancement: only use COS path when the API is available.
  if (!('crossOriginStorage' in navigator)) return fallbackToGoogleFonts();

  // Safe localStorage helpers — private browsing or quota errors must not abort font loading.
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

  const sha256Hex = async (buffer) =>
    [...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

  // Returns a File from COS, or null on NotFoundError (absent or privacy-gated).
  const getFromCOS = async (hash) => {
    try {
      const [handle] = await navigator.crossOriginStorage.requestFileHandles([
        { algorithm: 'SHA-256', value: hash },
      ]);
      return await handle.getFile();
    } catch (e) {
      if (e.name === 'NotFoundError') return null;
      throw e;
    }
  };

  // Stores a blob in COS with global-origin visibility so other sites can reuse it.
  // Non-fatal: a storage failure doesn't prevent the font from being used this session.
  const storeInCOS = async (blob, hash) => {
    try {
      const [handle] = await navigator.crossOriginStorage.requestFileHandles(
        [{ algorithm: 'SHA-256', value: hash }],
        { create: true, origins: '*' }
      );
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
    } catch {}
  };

  // Returns an ArrayBuffer for a font file URL.
  //
  // Fast path (hash cached in localStorage + COS hit): one COS lookup, no network.
  // Slow path (new versioned URL or COS eviction): fetch → return buffer immediately;
  //   SHA-256 + localStorage write + COS store all run in the background so that
  //   font rendering is not blocked by hash computation.
  //
  // The localStorage key encodes the full versioned URL, so a font update
  // (e.g. /v39/ → /v40/) automatically falls through to the slow path.
  const fetchFontBuffer = async (url) => {
    const cachedHash = lsGet('cos_fh:' + url);

    if (cachedHash) {
      const file = await getFromCOS(cachedHash);
      if (file) return file.arrayBuffer();
      // COS miss (evicted) — re-fetch and re-store with the same hash.
    }

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Fetch ${url} → ${res.status}`);
    const buffer = await res.arrayBuffer();

    // Hash, cache, and store without blocking font rendering.
    const mime = res.headers.get('content-type') || 'font/woff2';
    (async () => {
      const hash = await sha256Hex(buffer);
      lsSet('cos_fh:' + url, hash);
      storeInCOS(new Blob([buffer], { type: mime }), hash);
    })();

    return buffer;
  };

  const FACE_FIELDS = [
    ['family',       /font-family:\s*['"]([^'"]+)['"]/],
    ['style',        /font-style:\s*([^;]+)/,        'normal'],
    ['weight',       /font-weight:\s*([^;]+)/,       '400'],
    ['stretch',      /font-stretch:\s*([^;]+)/],
    ['display',      /font-display:\s*([^;]+)/,      'swap'],
    ['unicodeRange', /unicode-range:\s*([^;]+)/],
    ['url',          /url\(['"]?(https?:[^'")\s]+)['"]?\)/],
  ];

  const parseFontFaces = (css) =>
    [...css.matchAll(/@font-face\s*\{([^}]+)\}/g)]
      .map((m) => Object.fromEntries(
        FACE_FIELDS.map(([k, re, def]) => [k, (m[1].match(re)?.[1].trim()) ?? def])
      ))
      .filter((f) => f.family && f.url);

  // Parses max-age and stale-while-revalidate from a Cache-Control header,
  // returning both as milliseconds.
  const parseCacheControl = (header) => {
    const ms = (re) => { const m = re.exec(header ?? ''); return m ? +m[1] * 1000 : null; };
    return {
      maxAge: ms(/\bmax-age=(\d+)/i) ?? 86400_000,   // fallback if header absent
      swr:    ms(/\bstale-while-revalidate=(\d+)/i) ?? 0,
    };
  };

  // Fetches CSS, parses @font-face rules, and writes { faces, ts, maxAge, swr }
  // to localStorage. Strips text= so the full font is always used on the COS path.
  const fetchAndCacheCss = async (fetchUrl, cacheKey) => {
    const res = await fetch(fetchUrl);
    if (!res.ok) throw new Error(`CSS fetch → ${res.status}`);
    const faces = parseFontFaces(await res.text());
    const { maxAge, swr } = parseCacheControl(res.headers.get('cache-control'));
    lsSet(cacheKey, JSON.stringify({ faces, ts: Date.now(), maxAge, swr }));
    return faces;
  };

  // Returns cached @font-face descriptors for one CSS URL, fetching when needed.
  //
  // Cache behavior mirrors the Cache-Control headers from Google's response:
  //   Fresh  (age < max-age)            → return immediately, no network.
  //   Stale  (max-age ≤ age < max-age+swr) → return immediately; refresh in background.
  //   Expired (age ≥ max-age+swr)       → fetch synchronously, then cache.
  //   Absent (first visit)              → fetch synchronously, then cache.
  const getFontFaceDescriptors = async (cssUrl) => {
    let fetchUrl = cssUrl;
    try {
      const u = new URL(cssUrl);
      u.searchParams.delete('text');
      fetchUrl = u.toString();
    } catch {}

    const cacheKey = 'cos_font_css_dyn:' + fetchUrl;
    const cached = lsGet(cacheKey);
    if (cached) {
      try {
        const { faces, ts, maxAge, swr } = JSON.parse(cached);
        const age = Date.now() - ts;
        if (age < maxAge) return faces;
        if (age < maxAge + swr) {
          fetchAndCacheCss(fetchUrl, cacheKey).catch(() => {});
          return faces;
        }
      } catch {}
    }

    return fetchAndCacheCss(fetchUrl, cacheKey);
  };

  try {
    // Fetch descriptors for all CSS URLs in parallel, then flatten into one list.
    const allFaces = (await Promise.all(cssUrls.map(getFontFaceDescriptors))).flat();

    await Promise.allSettled(allFaces.map(async (face) => {
      // fetchFontBuffer returns an ArrayBuffer directly — no extra .arrayBuffer()
      // call needed, and no intermediate Blob on the network-fetch path.
      // blob: URLs require an explicit font-src blob: in the CSP, whereas
      // binary data passed directly to FontFace bypasses font-src entirely.
      const buffer = await fetchFontBuffer(face.url);
      const descriptors = { style: face.style, weight: face.weight, display: face.display };
      if (face.stretch) descriptors.stretch = face.stretch;
      if (face.unicodeRange) descriptors.unicodeRange = face.unicodeRange;
      const ff = new FontFace(face.family, buffer, descriptors);
      await ff.load();
      document.fonts.add(ff);
    }));
  } catch {
    fallbackToGoogleFonts();
  }
})();
