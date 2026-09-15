/* amz-research · shared page extractors
 * ---------------------------------------------------------------------------
 * Runs in two places against the same DOM:
 *   - Tampermonkey, via @require, on a page a person is looking at
 *   - Patchright, via page.addScriptTag, on a page the server loaded
 *
 * One parser, two transports. When Amazon changes markup it is fixed once.
 * Nothing here touches the network or the clipboard; it only reads the DOM
 * and returns plain objects.
 *
 * Attaches window.AmzExtract = { detect, bsr, pdp, PARSER_VERSION }
 */
(function (root) {
  'use strict';

  // Bump on any selector change. Stamped on every row so a later diff can tell
  // "the competitor changed their listing" from "we changed our parser".
  var PARSER_VERSION = '2026.09.14';

  var txt = function (el) {
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : null;
  };

  // Amazon hashes class names (_cDEzb_p13n-sc-price_3mJ9Z). Match the stable
  // substring in the middle, never the whole class.
  var sub = function (root, part) {
    return root.querySelector('[class*="' + part + '"]');
  };

  function detect(url) {
    var u = url || location.href;
    if (/\/(zgbs|bestsellers)\//.test(u)) return 'bsr';
    if (/\/(dp|product)\/[A-Z0-9]{10}/i.test(u)) return 'pdp';
    return null;
  }

  /* ---------------------------------------------------------------- bsr --*/

  function nodeIdFromUrl(u) {
    var m = (u || location.pathname).match(/\/(?:zgbs|bestsellers)\/[^/]+\/(\d+)/);
    if (m) return m[1];
    m = (u || location.pathname).match(/\/(?:zgbs|bestsellers)\/([^/?]+)/);
    return m ? m[1] : null;
  }

  function bestImage(img) {
    if (!img) return null;
    try {
      var map = JSON.parse(img.getAttribute('data-a-dynamic-image') || '{}');
      var best = null, w = 0;
      for (var url in map) {
        if (map[url][0] > w) { w = map[url][0]; best = url; }
      }
      if (best) return best;
    } catch (e) { /* fall through */ }
    return img.src || null;
  }

  function bsrTile(faceout) {
    var wrap = faceout, rank = null;
    for (var i = 0; i < 4 && wrap; i++) {
      var badge = wrap.querySelector('.zg-bdg-text');
      if (badge) { rank = parseInt(txt(badge).replace('#', ''), 10); break; }
      wrap = wrap.parentElement;
    }

    var inner = faceout.querySelector('.p13n-sc-uncoverable-faceout');
    var link  = faceout.querySelector('a[href*="/dp/"]');
    var href  = link ? link.getAttribute('href') : '';

    var asin = inner && /^[A-Z0-9]{10}$/.test(inner.id) ? inner.id : null;
    if (!asin) {
      var m = href.match(/\/dp\/([A-Z0-9]{10})/);
      asin = m ? m[1] : null;
    }
    if (!asin) return null;

    var img = faceout.querySelector('img.p13n-product-image, img[class*="p13n-product-image"]');
    var titleEl = sub(faceout, 'p13n-sc-css-line-clamp');
    var title = txt(titleEl) || (img ? img.getAttribute('alt') : null);

    var revLink = faceout.querySelector('a[aria-label*="out of 5 stars"]');
    var label = revLink ? revLink.getAttribute('aria-label') : '';
    var rm = label.match(/([\d.]+) out of 5/);
    var cm = label.match(/,\s*([\d,]+)\s*ratings?/);

    // some tiles read "MSRPClick for details" — require a real dollar figure
    var priceEl  = sub(faceout, 'p13n-sc-price');
    var priceRaw = txt(priceEl);
    var pm = priceRaw ? priceRaw.match(/\$([\d,]+\.?\d*)/) : null;

    return {
      asin: asin,
      rank: rank,
      title: title,
      price: pm ? parseFloat(pm[1].replace(/,/g, '')) : null,
      price_raw: priceRaw,
      rating: rm ? parseFloat(rm[1]) : null,
      review_ct: cm ? parseInt(cm[1].replace(/,/g, ''), 10) : null,
      image_url: bestImage(img),
      url: 'https://www.amazon.com/dp/' + asin
    };
  }

  function bsr() {
    var faceouts = document.querySelectorAll('.zg-grid-general-faceout');
    var rows = [];
    for (var i = 0; i < faceouts.length; i++) {
      var r = bsrTile(faceouts[i]);
      if (r) rows.push(r);
    }
    // de-dupe, keep the lowest rank seen for an ASIN
    var seen = {};
    rows.forEach(function (r) {
      var prev = seen[r.asin];
      if (!prev || (r.rank || 999) < (prev.rank || 999)) seen[r.asin] = r;
    });
    var out = Object.keys(seen).map(function (k) { return seen[k]; });
    out.sort(function (a, b) { return (a.rank || 999) - (b.rank || 999); });

    return {
      source: 'bsr',
      parser_version: PARSER_VERSION,
      node_id: nodeIdFromUrl(location.pathname),
      page_url: location.href,
      captured_at: new Date().toISOString(),
      count: out.length,
      items: out
    };
  }

  /* ---------------------------------------------------------------- pdp --*/

  function pdp() {
    // three states per field:
    //   value      captured
    //   null       container found, genuinely empty   (confirmed absent)
    //   missing[]  container not found                (capture failure)
    var missing = [];

    var region = function (sel, label) {
      var el = document.querySelector(sel);
      if (!el) { missing.push(label); return null; }
      return el;
    };

    var asin = (function () {
      var m = location.pathname.match(/\/(?:dp|product)\/([A-Z0-9]{10})/);
      if (m) return m[1];
      var el = document.querySelector('[data-csa-c-asin]');
      return el ? el.getAttribute('data-csa-c-asin') : null;
    })();

    // bullets — the "See more details" link sits outside the <ul>
    var bullets = null;
    var fb = region('#feature-bullets', 'feature-bullets');
    if (fb) {
      bullets = [];
      var lis = fb.querySelectorAll('ul li span.a-list-item');
      for (var i = 0; i < lis.length; i++) {
        var t = txt(lis[i]);
        if (t) bullets.push(t);
      }
    }

    // images — hi-res lives in the colorImages payload, not the DOM
    var images = null;
    var scripts = document.querySelectorAll('script');
    var payload = null;
    for (var s = 0; s < scripts.length; s++) {
      if (scripts[s].textContent.indexOf('colorImages') !== -1) { payload = scripts[s]; break; }
    }
    if (payload) {
      var pm = payload.textContent.match(/A\.\$\.parseJSON\('(\[[\s\S]*?\])'\)/);
      if (pm) {
        try {
          images = JSON.parse(pm[1]).map(function (o, i) {
            return {
              index: i,
              variant: o.variant || null,
              hires: o.hiRes || o.large || null,
              thumb: o.thumb || null
            };
          });
        } catch (e) { /* fall through */ }
      }
    }
    if (!images) {
      missing.push('colorImages-payload');
      var alt = document.querySelectorAll('#altImages li.imageThumbnail img');
      if (!alt.length) {
        missing.push('altImages');
      } else {
        // thumb URLs use a different physical id than hiRes and cannot be
        // upscaled, so flag them rather than pretending they are equivalent
        images = [];
        for (var a = 0; a < alt.length; a++) {
          images.push({ index: a, variant: null, hires: null, thumb: alt[a].src, thumb_only: true });
        }
      }
    }

    // A+ — "From the brand" is brand story, not A+ product content. Amazon
    // renders both inside #aplus, and the class `aplus-module` appears on
    // both, so presence is decided by the "From the manufacturer" heading.
    var aplus = { present: false, modules: null, module_ct: 0, text: null,
                  brand_story: false, brand_story_modules: null };
    var ap = document.querySelector('#aplus, #aplus_feature_div');
    if (!ap) {
      missing.push('aplus');
    } else {
      var bsMods = {};
      var bsEls = ap.querySelectorAll('[class*="brand-story"]');
      for (var b = 0; b < bsEls.length; b++) {
        var cl = bsEls[b].classList;
        for (var c = 0; c < cl.length; c++) {
          if (/brand-story/i.test(cl[c])) bsMods[cl[c]] = 1;
        }
      }
      var bsList = Object.keys(bsMods).sort();

      var clone = ap.cloneNode(true);
      var strip = clone.querySelectorAll('style, script, noscript, [class*="brand-story"]');
      for (var x = 0; x < strip.length; x++) strip[x].remove();
      var h2s = clone.querySelectorAll('h2');
      for (var h = 0; h < h2s.length; h++) {
        if (/from the brand/i.test(h2s[h].textContent || '')) {
          var wrapEl = h2s[h].closest('div');
          if (wrapEl) wrapEl.remove(); else h2s[h].remove();
        }
      }

      var mods = {};
      var modEls = clone.querySelectorAll('.aplus-module, [class*="apm-"]');
      for (var m2 = 0; m2 < modEls.length; m2++) {
        var cl2 = modEls[m2].classList;
        for (var c2 = 0; c2 < cl2.length; c2++) {
          var name = cl2[c2];
          if (/^(aplus-module|apm-)/.test(name) && name !== 'aplus-module' && !/brand-story/i.test(name)) {
            mods[name] = 1;
          }
        }
      }
      var modList = Object.keys(mods).sort();
      var body = txt(clone);
      var fromManufacturer = /from the manufacturer/i.test(ap.textContent || '');

      aplus = {
        present: fromManufacturer || modList.length > 0,
        modules: modList.length ? modList : null,
        module_ct: modList.length,
        text: body ? body.slice(0, 8000) : null,
        brand_story: bsList.length > 0 || !!document.querySelector('#aplusBrandStory_feature_div'),
        brand_story_modules: bsList.length ? bsList : null
      };
    }

    // price
    var price = null, priceRaw = null;
    var pbox = document.querySelector('#corePrice_feature_div, #corePriceDisplay_desktop_feature_div');
    if (!pbox) {
      missing.push('price-block');
    } else {
      priceRaw = txt(pbox.querySelector('.a-price .a-offscreen'));
      var pm2 = priceRaw ? priceRaw.match(/\$([\d,]+\.?\d*)/) : null;
      price = pm2 ? parseFloat(pm2[1].replace(/,/g, '')) : null;
    }

    // rating
    var rating = null, reviewCt = null;
    var acr = document.querySelector('#acrPopover');
    var acrTxt = document.querySelector('#acrCustomerReviewText');
    if (!acr && !acrTxt) {
      missing.push('rating-block');
    } else {
      var lab = acr ? (acr.getAttribute('title') || txt(acr)) : '';
      var rm2 = lab ? lab.match(/([\d.]+)\s*out of 5/) : null;
      rating = rm2 ? parseFloat(rm2[1]) : null;
      var ct = txt(acrTxt);
      var cm2 = ct ? ct.match(/([\d,]+)/) : null;
      reviewCt = cm2 ? parseInt(cm2[1].replace(/,/g, ''), 10) : null;
    }

    // best sellers rank — the block naming which lists this product sits in
    var bsrRaw = null, bsrNodes = null;
    var holders = ['#detailBulletsWrapper_feature_div', '#detailBullets_feature_div',
                   '#productDetails_detailBullets_sections1', '#prodDetails'];
    var host = null;
    for (var hh = 0; hh < holders.length; hh++) {
      host = document.querySelector(holders[hh]);
      if (host) break;
    }
    if (!host) {
      missing.push('bsr-block');
    } else {
      var cells = host.querySelectorAll('li, tr, th, td');
      for (var cc = 0; cc < cells.length; cc++) {
        var ct2 = txt(cells[cc]);
        if (ct2 && /Best Sellers Rank/i.test(ct2) && (!bsrRaw || ct2.length > bsrRaw.length)) bsrRaw = ct2;
      }
      if (!bsrRaw) {
        missing.push('bsr-text');
      } else {
        bsrNodes = [];
        var as = host.querySelectorAll('a[href*="/zgbs/"], a[href*="/bestsellers/"]');
        for (var aa = 0; aa < as.length; aa++) {
          var href2 = as[aa].getAttribute('href') || '';
          var nm = href2.match(/\/(?:zgbs|bestsellers)\/[^/]+\/(\d+)/);
          bsrNodes.push({
            name: txt(as[aa]),
            node_id: nm ? nm[1] : null,
            url: href2.indexOf('http') === 0 ? href2 : 'https://www.amazon.com' + href2
          });
        }
        var ranks = bsrRaw.match(/#[\d,]+\s+in\s+[^(#]+/g) || [];
        for (var rr = 0; rr < ranks.length; rr++) {
          var rv = ranks[rr].match(/#([\d,]+)/);
          if (bsrNodes[rr] && rv) bsrNodes[rr].rank = parseInt(rv[1].replace(/,/g, ''), 10);
        }
        bsrRaw = bsrRaw.slice(0, 600);
        if (!bsrNodes.length) bsrNodes = null;
      }
    }

    var badges = [];
    ['#acBadge_feature_div .ac-badge-text-primary',
     '#acBadge_feature_div .ac-badge-text-secondary',
     '#zeitgeistBadge_feature_div .badge-link',
     '#bestSellerBadge',
     '.badge-wrapper .badge-text'].forEach(function (sel) {
      var els = document.querySelectorAll(sel);
      for (var i = 0; i < els.length; i++) {
        var t = txt(els[i]);
        // reject data attributes leaking through as text, e.g. {"acAsin":"..."}
        if (!t || t.charAt(0) === '{' || t.indexOf('acAsin') !== -1 || t.length > 120) continue;
        if (badges.indexOf(t) === -1) badges.push(t);
      }
    });

    var brandEl = document.querySelector('#bylineInfo');
    var brand = txt(brandEl);
    if (brand) brand = brand.replace(/^(Visit the|Brand:)\s*/i, '').replace(/\s*Store$/i, '');

    var blob = function (sel) {
      var e = document.querySelector(sel);
      return e ? e.outerHTML.slice(0, 200000) : null;
    };

    return {
      source: 'pdp',
      parser_version: PARSER_VERSION,
      asin: asin,
      url: location.origin + location.pathname,
      captured_at: new Date().toISOString(),
      title: txt(region('#productTitle', 'title')),
      brand: brand,
      price: price,
      price_raw: priceRaw,
      rating: rating,
      review_ct: reviewCt,
      seller: txt(document.querySelector('#sellerProfileTriggerId, #merchant-info a')),
      badges: badges.length ? badges : null,
      coupon: txt(document.querySelector('#promoPriceBlockMessage, [class*="couponBadge"], #vpcButton')),
      variation_ct: document.querySelectorAll('#variation_color_name li, #variation_style_name li, #variation_size_name li').length || null,
      bullets: bullets,
      bullet_ct: bullets ? bullets.length : null,
      images: images,
      image_ct: images ? images.length : null,
      has_video: !!document.querySelector('#altImages li.videoThumbnail, #altImages li.videoBlockIngress'),
      aplus_present: aplus.present,
      aplus_modules: aplus.modules,
      aplus_module_ct: aplus.module_ct,
      aplus_text: aplus.text,
      brand_story: aplus.brand_story,
      brand_story_modules: aplus.brand_story_modules,
      bsr_raw: bsrRaw,
      bsr_nodes: bsrNodes,
      missing: missing,
      raw_html: { bullets: blob('#feature-bullets'), aplus: blob('#aplus'), gallery: blob('#altImages') }
    };
  }

  root.AmzExtract = {
    PARSER_VERSION: PARSER_VERSION,
    detect: detect,
    bsr: bsr,
    pdp: pdp
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
