// ==UserScript==
// @name         AMZ Capture
// @namespace    amzresearch
// @version      1.0.0
// @description  Capture Amazon bestseller lists and product pages into amzresearch
// @author       amzresearch
// @match        https://www.amazon.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      n8n-si.asasson.xyz
// @require      https://raw.githubusercontent.com/OWNER/REPO/main/shared/extract.js?v=1
// @run-at       document-idle
// ==/UserScript==

/* -----------------------------------------------------------------------------
 * This file is the header and the transport. All parsing lives in
 * shared/extract.js, loaded above via @require, so the same code runs here and
 * anywhere else that needs it. Fix a selector once.
 *
 * Two things to set before first use, both stored locally per browser:
 *   - the n8n base URL
 *   - the webhook key
 * The script prompts on first run. Tampermonkey's menu has "Settings" to change
 * them later. Nothing secret is committed to the repo.
 *
 * Note on @require caching: Tampermonkey fetches the required file on install
 * and on version bump, not on every load. After changing extract.js, bump the
 * ?v= number above AND the @version line, or installs keep the old copy.
 * -------------------------------------------------------------------------- */

(function () {
  'use strict';

  var HOOKS = { bsr: '/webhook/amz-bsr', pdp: '/webhook/amazon-page' };

  function cfg() {
    return {
      base: GM_getValue('n8n_base', ''),
      key:  GM_getValue('api_key', '')
    };
  }

  function configure(force) {
    var c = cfg();
    if (force || !c.base) {
      var base = prompt('n8n base URL (no trailing slash)', c.base || 'https://n8n-si.asasson.xyz');
      if (base === null) return null;
      GM_setValue('n8n_base', base.replace(/\/$/, ''));
    }
    if (force || !c.key) {
      var key = prompt('Webhook key (X-Api-Key)', c.key || '');
      if (key === null) return null;
      GM_setValue('api_key', key.trim());
    }
    return cfg();
  }

  GM_registerMenuCommand('AMZ Capture — settings', function () { configure(true); });

  if (typeof window.AmzExtract === 'undefined') {
    console.error('[AMZ] extract.js did not load. Check the @require URL.');
    return;
  }

  var kind = window.AmzExtract.detect(location.href);
  if (!kind) return;                       // not a page we capture; stay invisible

  /* ---- scroll so lazy content is present ------------------------------- */
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function settle(onProgress) {
    var y = window.scrollY, last = -1;
    for (var i = 0; i < 20; i++) {
      if (kind === 'bsr') {
        var n = document.querySelectorAll('.zg-grid-general-faceout').length;
        if (onProgress) onProgress('Loading… ' + n);
        if (n === last && i > 3) break;
        last = n;
      }
      window.scrollBy(0, window.innerHeight * 0.85);
      await sleep(450);
    }
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(800);
    window.scrollTo(0, y);
    await sleep(300);
  }

  /* ---- send ------------------------------------------------------------ */
  function send(payload, done) {
    var c = cfg();
    if (!c.base || !c.key) { done('not configured'); return; }
    GM_xmlhttpRequest({
      method: 'POST',
      url: c.base + HOOKS[kind],
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': c.key },
      data: JSON.stringify(payload),
      onload: function (r) {
        done(r.status >= 200 && r.status < 300 ? 'sent ' + r.status : 'HTTP ' + r.status);
      },
      onerror: function () { done('failed — check @connect and the URL'); }
    });
  }

  /* ---- button ---------------------------------------------------------- */
  var btn = document.createElement('button');
  Object.assign(btn.style, {
    position: 'fixed', bottom: '20px', right: '20px', zIndex: 2147483647,
    padding: '10px 16px', border: 'none', borderRadius: '4px',
    background: kind === 'bsr' ? '#146EB4' : '#B12704', color: '#fff',
    font: '500 14px/1 Arial, sans-serif', cursor: 'pointer',
    boxShadow: '0 2px 8px rgba(0,0,0,.3)'
  });
  btn.textContent = kind === 'bsr' ? 'Capture list' : 'Capture product';

  btn.onclick = async function () {
    if (!configure(false)) return;
    btn.disabled = true;
    await settle(function (s) { btn.textContent = s; });

    btn.textContent = 'Reading…';
    var payload = window.AmzExtract[kind]();

    // say plainly when the page did not give us what it should have, rather
    // than posting a hollow row that looks fine until someone reads it
    var thin = (kind === 'bsr' && (!payload.items || payload.items.length < 10)) ||
               (kind === 'pdp' && !payload.title);
    if (thin) {
      btn.textContent = 'Page looks wrong — not sent';
      console.warn('[AMZ] thin capture, not sent:', payload);
      setTimeout(reset, 6000);
      return;
    }

    var note = kind === 'bsr'
      ? payload.items.length + ' items'
      : (payload.missing.length ? payload.missing.length + ' missing' : 'ok');

    btn.textContent = 'Sending…';
    send(payload, function (msg) {
      btn.textContent = note + ' · ' + msg;
      console.log('[AMZ]', kind, payload);
      setTimeout(reset, 5000);
    });
  };

  function reset() {
    btn.disabled = false;
    btn.textContent = kind === 'bsr' ? 'Capture list' : 'Capture product';
  }

  document.body.appendChild(btn);
})();
