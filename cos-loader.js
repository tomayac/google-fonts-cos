(async () => {
  const LOG = '[COS Fonts]';

  // Collect Google Fonts CSS URLs from every <noscript data-cos-fonts> block.
  // Supports multiple blocks and multiple <link> tags per block.
  function collectCssUrls() {
    const parser = new DOMParser();
    const urls = new Set();
    for (const ns of document.querySelectorAll('noscript[data-cos-fonts]')) {
      const doc = parser.parseFromString(ns.innerHTML, 'text/html');
      for (const link of doc.querySelectorAll('link[rel="stylesheet"]')) {
        try {
          if (new URL(link.href).hostname === 'fonts.googleapis.com')
            urls.add(link.href);
        } catch {}
      }
    }
    return [...urls];
  }

  // #build-remove-start — collectHashMap is replaced by the injected literal at build time.
  // Collect the pre-computed stem→SHA-256 map from every
  // <script type="text/plain" data-cos-fonts> inside <noscript data-cos-fonts> blocks.
  function collectHashMap() {
    const parser = new DOMParser();
    const map = {};
    for (const ns of document.querySelectorAll('noscript[data-cos-fonts]')) {
      const doc = parser.parseFromString(ns.innerHTML, 'text/html');
      for (const script of doc.querySelectorAll(
        'script[type="text/plain"][data-cos-fonts]'
      )) {
        try {
          Object.assign(map, JSON.parse(script.textContent));
        } catch {}
      }
    }
    return map;
  }
  // #build-remove-end

  function fallbackToGoogleFonts(cssUrls) {
    console.log(LOG, `Falling back: injecting ${cssUrls.length} <link> tag(s)`);
    for (const url of cssUrls) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = url;
      document.head.appendChild(link);
    }
  }

  const cssUrls = collectCssUrls();
  if (cssUrls.length === 0) {
    console.log(
      LOG,
      'No <noscript data-cos-fonts> blocks found — nothing to do'
    );
    return;
  }
  console.log(LOG, `Found ${cssUrls.length} Google Fonts CSS URL(s):`, cssUrls);

  const hashMap = collectHashMap();
  const hashMapSize = Object.keys(hashMap).length;
  console.log(
    LOG,
    hashMapSize > 0
      ? `Pre-computed hashes: ${hashMapSize} font file(s) — COS queries need no network fetch on hit`
      : 'No pre-computed hashes found — will compute SHA-256 from content after download'
  );

  // Progressive enhancement: only use COS path when the API is available.
  if (!('crossOriginStorage' in navigator)) {
    console.log(
      LOG,
      'crossOriginStorage not available — falling back to Google Fonts <link>'
    );
    fallbackToGoogleFonts(cssUrls);
    return;
  }
  console.log(
    LOG,
    'crossOriginStorage available — using COS font loading path'
  );

  // Safe localStorage helpers — private browsing or quota errors must not abort font loading.
  const lsGet = (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  const lsSet = (key, val) => {
    try {
      localStorage.setItem(key, val);
    } catch {}
  };

  async function sha256Hex(buffer) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(hashBuffer), (b) =>
      b.toString(16).padStart(2, '0')
    ).join('');
  }

  // Returns a File blob from COS, or null on NotFoundError (absent or privacy-gated).
  async function getFromCOS(hash) {
    try {
      console.log(LOG, `  COS lookup   hash=${hash}`);
      const [handle] = await navigator.crossOriginStorage.requestFileHandles([
        { algorithm: 'SHA-256', value: hash },
      ]);
      const file = await handle.getFile();
      console.log(LOG, `  COS hit      ${(file.size / 1024).toFixed(1)} KB`);
      return file;
    } catch (e) {
      if (e.name === 'NotFoundError') {
        console.log(LOG, `  COS miss     (not found or privacy-gated)`);
        return null;
      }
      throw e;
    }
  }

  // Stores a blob in COS with global-origin visibility so other sites can reuse it.
  // Non-fatal: a storage failure doesn't prevent the font from being used this session.
  async function storeInCOS(blob, hash) {
    try {
      console.log(
        LOG,
        `  COS store    hash=${hash} size=${(blob.size / 1024).toFixed(1)} KB origins=*`
      );
      const [handle] = await navigator.crossOriginStorage.requestFileHandles(
        [{ algorithm: 'SHA-256', value: hash }],
        { create: true, origins: '*' }
      );
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      console.log(LOG, `  COS store    done`);
    } catch (e) {
      console.warn(LOG, `  COS store    failed: ${e.message}`);
    }
  }

  // Returns a blob for a font file URL.
  //
  // Hash resolution order (first wins):
  //   1. Pre-computed map embedded in the page  → no download needed to know the hash
  //   2. localStorage (computed on a prior visit) → same
  //   3. Download the file and compute SHA-256 from its content
  //
  // Once the hash is known, COS is queried. On a miss the file is fetched (if not
  // already downloaded in step 3) and stored in COS for future cross-origin reuse.
  async function fetchFontBlob(url) {
    const stem = url
      .split('/')
      .pop()
      .replace(/\.[^.]+$/, '');
    const precomputedHash = hashMap[stem];
    const knownHash = precomputedHash ?? lsGet('cos_fh:' + url);

    if (knownHash) {
      console.log(
        LOG,
        precomputedHash
          ? `  Pre-computed hash  ${knownHash}`
          : `  Cached hash  ${knownHash}`
      );
      const file = await getFromCOS(knownHash);
      if (file) return file;
      // COS miss (evicted or privacy-gated) — fall through to network fetch.
    }

    console.log(LOG, `  Network fetch ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Fetch ${url} → ${res.status}`);
    const buffer = await res.arrayBuffer();
    const type = res.headers.get('content-type') || 'font/woff2';
    const blob = new Blob([buffer], { type });
    console.log(
      LOG,
      `  Network fetch done  ${(blob.size / 1024).toFixed(1)} KB`
    );

    // Pre-computed hash is trusted; otherwise compute from content and cache it.
    const hash = precomputedHash ?? (await sha256Hex(buffer));
    if (!precomputedHash) {
      console.warn(
        LOG,
        `  No pre-computed hash for "${stem}" — computed from content.`,
        `Re-run hash-calculator.html and update the hash map in the page.`
      );
      lsSet('cos_fh:' + url, hash);
    }

    // Fire-and-forget: font is usable from the in-memory blob even if COS storage is slow.
    storeInCOS(blob, hash);

    return blob;
  }

  // Strip text= so COS always caches the full (unsubsetted) font.
  // The noscript fallback <link> keeps text= for browsers that don't use COS.
  function stripTextParam(url) {
    try {
      const u = new URL(url);
      u.searchParams.delete('text');
      return u.toString();
    } catch {
      return url;
    }
  }

  // Parses @font-face rules from a Google Fonts CSS response.
  // Extracts the first https: URL per block (modern browsers always receive woff2).
  function parseFontFaces(css) {
    const faces = [];
    const ruleRe = /@font-face\s*\{([^}]+)\}/g;
    let m;
    while ((m = ruleRe.exec(css)) !== null) {
      const block = m[1];
      const get = (re) => {
        const r = re.exec(block);
        return r ? r[1].trim() : null;
      };
      const family = get(/font-family:\s*['"]([^'"]+)['"]/);
      const url = get(/url\(['"]?(https?:[^'")\s]+)['"]?\)/);
      if (!family || !url) continue;
      faces.push({
        family,
        style: get(/font-style:\s*([^;]+)/) || 'normal',
        weight: get(/font-weight:\s*([^;]+)/) || '400',
        stretch: get(/font-stretch:\s*([^;]+)/),
        display: get(/font-display:\s*([^;]+)/) || 'swap',
        unicodeRange: get(/unicode-range:\s*([^;]+)/),
        url,
      });
    }
    return faces;
  }

  // Fetches and caches the @font-face descriptors for one CSS URL in localStorage.
  // Strips text= before fetching so the full font is always used on the COS path.
  // Repeat visits skip the network request entirely for each URL.
  async function getFontFaceDescriptors(cssUrl) {
    const fetchUrl = stripTextParam(cssUrl);
    const cacheKey = 'cos_font_css_v1:' + fetchUrl;
    const cached = lsGet(cacheKey);
    if (cached) {
      try {
        const faces = JSON.parse(cached);
        console.log(
          LOG,
          `CSS descriptors from localStorage: ${fetchUrl} (${faces.length} faces)`
        );
        return faces;
      } catch {}
    }
    console.log(LOG, `Fetching Google Fonts CSS: ${fetchUrl}`);
    const res = await fetch(fetchUrl);
    if (!res.ok) throw new Error(`CSS fetch → ${res.status}`);
    const css = await res.text();
    const faces = parseFontFaces(css);
    console.log(
      LOG,
      `CSS parsed: ${faces.length} @font-face rules found in ${fetchUrl}`
    );
    lsSet(cacheKey, JSON.stringify(faces));
    return faces;
  }

  try {
    // Fetch descriptors for all CSS URLs in parallel, then flatten into one list.
    const allFaces = (
      await Promise.all(cssUrls.map(getFontFaceDescriptors))
    ).flat();
    console.log(LOG, `Loading ${allFaces.length} font faces total…`);

    const results = await Promise.allSettled(
      allFaces.map(async (face) => {
        const label = `${face.family} weight=${face.weight} style=${face.style}${face.unicodeRange ? ' unicode=' + face.unicodeRange.slice(0, 20) + '…' : ''}`;
        console.log(`${LOG} ${label}`);
        try {
          const blob = await fetchFontBlob(face.url);
          // Pass the font data as an ArrayBuffer rather than a blob: URL.
          // blob: URLs require an explicit font-src blob: in the CSP, whereas
          // binary data passed directly to FontFace bypasses font-src entirely.
          const buffer = await blob.arrayBuffer();
          const descriptors = {
            style: face.style,
            weight: face.weight,
            display: face.display,
          };
          if (face.stretch) descriptors.stretch = face.stretch;
          if (face.unicodeRange) descriptors.unicodeRange = face.unicodeRange;
          const ff = new FontFace(face.family, buffer, descriptors);
          await ff.load();
          document.fonts.add(ff);
          console.log(LOG, `  FontFace loaded and added to document.fonts`);
        } catch (e) {
          console.warn(LOG, `  Failed: ${e.message}`);
          throw e;
        }
      })
    );

    const loaded = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.length - loaded;
    console.log(
      LOG,
      `Done: ${loaded} faces loaded${failed ? `, ${failed} failed` : ''}`
    );
  } catch (e) {
    console.warn(LOG, 'Falling back to Google Fonts:', e.message);
    fallbackToGoogleFonts(cssUrls);
  }
})();
