(async () => {
  // Collect Google Fonts CSS URLs from every <noscript data-cos-fonts> block.
  // Supports multiple blocks and multiple <link> tags per block.
  const parser = new DOMParser();
  const parseNoscripts = (selector) =>
    [...document.querySelectorAll('noscript[data-cos-fonts]')].flatMap((ns) =>
      [...parser.parseFromString(ns.innerHTML, 'text/html').querySelectorAll(selector)]
    );

  const cssUrls = [...new Set(
    parseNoscripts('link[rel="stylesheet"]')
      .map((l) => l.href)
      .filter((h) => {
        try { return new URL(h).hostname === 'fonts.googleapis.com'; } catch { return false; }
      })
  )];

  if (!cssUrls.length) return;

  const fallbackToGoogleFonts = () => {
    for (const href of cssUrls) {
      document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href }));
    }
  };

  // Progressive enhancement: only use COS path when the API is available.
  if (!('crossOriginStorage' in navigator)) return fallbackToGoogleFonts();

  // #build-remove-start — collectHashMap is replaced by the injected literal at build time.
  // Collect the pre-computed stem→SHA-256 map from every
  // <script type="text/plain" data-cos-fonts> inside <noscript data-cos-fonts> blocks.
  function collectHashMap() {
    const map = {};
    for (const script of parseNoscripts('script[type="text/plain"][data-cos-fonts]')) {
      try { Object.assign(map, JSON.parse(script.textContent)); } catch {}
    }
    return map;
  }
  // #build-remove-end
  const hashMap = collectHashMap();

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

  // Returns a blob for a font file URL.
  //
  // Hash resolution order (first wins):
  // 1. Pre-computed map embedded in the page → no download needed to know the hash
  // 2. localStorage (computed on a prior visit) → same
  // 3. Download the file and compute SHA-256 from its content
  //
  // Once the hash is known, COS is queried. On a miss the file is fetched (if not
  // already downloaded in step 3) and stored in COS for future cross-origin reuse.
  const fetchFontBlob = async (url) => {
    const stem = url.split('/').pop().replace(/\.[^.]+$/, '');
    const precomputedHash = hashMap[stem];
    const knownHash = precomputedHash ?? lsGet('cos_fh:' + url);

    if (knownHash) {
      const file = await getFromCOS(knownHash);
      if (file) return file;
      // COS miss (evicted or privacy-gated) — fall through to network fetch.
    }

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Fetch ${url} → ${res.status}`);
    const buffer = await res.arrayBuffer();
    const blob = new Blob([buffer], { type: res.headers.get('content-type') || 'font/woff2' });

    // Pre-computed hash is trusted; otherwise compute from content and cache it.
    const hash = precomputedHash ?? (await sha256Hex(buffer));
    if (!precomputedHash) lsSet('cos_fh:' + url, hash);

    // Fire-and-forget: font is usable from the in-memory blob even if COS storage is slow.
    storeInCOS(blob, hash);
    return blob;
  };

  // Parses @font-face rules from a Google Fonts CSS response.
  // Extracts the first https: URL per block (modern browsers always receive woff2).
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

  // Fetches and caches the @font-face descriptors for one CSS URL in localStorage.
  // Strips text= before fetching so the full font is always used on the COS path.
  // Repeat visits skip the network request entirely for each URL.
  const getFontFaceDescriptors = async (cssUrl) => {
    let fetchUrl = cssUrl;
    try {
      const u = new URL(cssUrl);
      u.searchParams.delete('text');
      fetchUrl = u.toString();
    } catch {}

    const cacheKey = 'cos_font_css_v1:' + fetchUrl;
    const cached = lsGet(cacheKey);
    if (cached) {
      try { return JSON.parse(cached); } catch {}
    }

    const res = await fetch(fetchUrl);
    if (!res.ok) throw new Error(`CSS fetch → ${res.status}`);
    const faces = parseFontFaces(await res.text());
    lsSet(cacheKey, JSON.stringify(faces));
    return faces;
  };

  try {
    // Fetch descriptors for all CSS URLs in parallel, then flatten into one list.
    const allFaces = (await Promise.all(cssUrls.map(getFontFaceDescriptors))).flat();

    await Promise.allSettled(allFaces.map(async (face) => {
      const blob = await fetchFontBlob(face.url);
      // Pass the font data as an ArrayBuffer rather than a blob: URL.
      // blob: URLs require an explicit font-src blob: in the CSP, whereas
      // binary data passed directly to FontFace bypasses font-src entirely.
      const buffer = await blob.arrayBuffer();
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