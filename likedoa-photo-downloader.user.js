// ==UserScript==
// @name         來客多 依關鍵字批次下載貼文首圖
// @namespace    likedoa-photo-downloader
// @version      2.1
// @description  貼上商品清單(可含日期/價格/emoji)，自動清成商品名稱，逐一用頁面搜尋欄搜尋，前往FB貼文並下載第一張照片(排除影片)
// @match        https://seller.likedoa.com/*
// @match        https://www.facebook.com/*
// @match        https://facebook.com/*
// @match        https://m.facebook.com/*
// @match        https://*.facebook.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_download
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  // 這個分頁自己的識別碼，用來避免另開監看分頁時兩邊搶著操作
  const TAB_ID = 'tab_' + Date.now() + '_' + Math.random().toString(36).slice(2);

  const MAX_RESULTS_PER_KEYWORD = 10; // 同一個關鍵字搜尋出多筆時，最多處理幾筆(防呆)

  const K = {
    active: 'lpd_active',
    step: 'lpd_step',
    kwList: 'lpd_kw_list',         // JSON: [{raw, name, fallback}]
    kwIndex: 'lpd_kw_index',       // 目前第幾個關鍵字
    kwAttempt: 'lpd_kw_attempt',   // 0=用完整商品名稱搜尋, 1=改用較短的備用字串
    resIndex: 'lpd_res_index',     // 該關鍵字搜尋結果中，目前處理第幾張卡片
    resTotal: 'lpd_res_total',     // 該關鍵字搜尋結果共幾張(-1=尚未搜尋)
    notFound: 'lpd_not_found',     // JSON: 搜尋不到的關鍵字
    fallbackUsed: 'lpd_fallback_used', // JSON: 用備用字串才找到的關鍵字(請人工確認)
    fbDone: 'lpd_fb_done',
    curOrderTitle: 'lpd_cur_order_title',
    leaderTabId: 'lpd_leader_tab_id',
    doneCount: 'lpd_done_count',
    failCount: 'lpd_fail_count',
    subfolder: 'lpd_subfolder',
  };

  const STEP = {
    NONE: 'none',
    NEED_SEARCH: 'need_search',
    WAIT_GO_TO_POST: 'wait_go_to_post',
    WAITING_FB_TAB: 'waiting_fb_tab',
  };

  function isActive() { return GM_getValue(K.active, 'no') === 'yes'; }
  function getStep() { return GM_getValue(K.step, STEP.NONE); }
  function setStep(s) { GM_setValue(K.step, s); }
  function isLeaderTab() { return GM_getValue(K.leaderTabId, '') === TAB_ID; }
  function getJson(key, def) {
    try { return JSON.parse(GM_getValue(key, '')) || def; } catch (e) { return def; }
  }
  function stopBatch(msg) {
    GM_setValue(K.active, 'no');
    GM_deleteValue(K.step);
    GM_deleteValue(K.leaderTabId);
    if (msg) alert(msg);
  }

  function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
  function delay(fn, min, max) { setTimeout(fn, rand(min, max)); }

  function waitFor(finder, timeoutMs, cb) {
    const start = Date.now();
    const timer = setInterval(() => {
      const el = finder();
      if (el) {
        clearInterval(timer);
        cb(el);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        cb(null);
      }
    }, 300);
  }

  // ------------------------------------------------------------------
  // 關鍵字清洗：去掉頭尾的 emoji / 日期代碼 / 價格，只留商品名稱
  // ------------------------------------------------------------------
  const DECOR = '\\p{Extended_Pictographic}\\u2B55\\uFE0F\\u200D\\u2705\\u2714\\u2757\\u2755';
  const HEAD_DECOR_RE = new RegExp('^[\\s' + DECOR + ']+', 'u');
  const TAIL_DECOR_RE = new RegExp('[\\s' + DECOR + ']+$', 'u');

  function cleanKeyword(line) {
    let s = (line || '').replace(/\r/g, '').trim();
    // 去掉結尾價格：「$35」「＄99」「NT$99」「 99元」等
    s = s.replace(/\s*(NT)?[\$＄]\s*\d[\d,]*(\.\d+)?\s*(元|起)?[\s\S]*$/iu, '');
    s = s.replace(/\s+\d[\d,]*\s*元\s*$/u, '');
    // 頭尾 emoji / 裝飾符號
    s = s.replace(HEAD_DECOR_RE, '').replace(TAIL_DECOR_RE, '');
    // 開頭日期代碼：「260929-」「261003－」「[260929]」「260929 」
    s = s.replace(/^[\[\(【（]?\d{6}[\]\)】）]?\s*[-－–—_:：]?\s*/u, '');
    // 再清一次頭尾 emoji，並把連續空白壓成一個
    s = s.replace(HEAD_DECOR_RE, '').replace(TAIL_DECOR_RE, '').replace(/\s+/g, ' ').trim();
    return s;
  }

  // 備用搜尋字串：整個名稱搜不到時，改用名稱裡最長的一段文字(去掉標點、emoji)
  function fallbackKeyword(name) {
    const noEmoji = name.replace(new RegExp('[' + DECOR + ']', 'gu'), ' ');
    const segs = noEmoji.split(/[\s\p{P}\p{S}]+/u).filter(x => x.length >= 3);
    if (segs.length === 0) return '';
    segs.sort((a, b) => b.length - a.length);
    const best = segs[0];
    return best === name ? '' : best;
  }

  // ------------------------------------------------------------------
  // 清單頁：找元素
  // ------------------------------------------------------------------
  function findGoToPostButton() {
    const buttons = Array.from(document.querySelectorAll('button.el-button--primary'));
    return buttons.find(b => (b.textContent || '').includes('前往貼文')) || null;
  }

  function findAllCardTitleEls() {
    return Array.from(document.querySelectorAll('.opengrouptitle'));
  }

  function getCardTitleText(el) {
    return (el.getAttribute('title') || el.textContent || '').trim();
  }

  function findSearchInput() {
    return document.querySelector('input[placeholder*="關鍵字"]');
  }

  function findSearchButton() {
    const buttons = Array.from(document.querySelectorAll('button'));
    return buttons.find(b => ['搜索', '搜尋'].includes((b.textContent || '').replace(/\s+/g, ''))) || null;
  }

  // 對 Vue / Element UI 的輸入框正確塞值(要用原生 setter 再送 input 事件)
  function setNativeValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // 等搜尋結果穩定：卡片數量連續兩次一樣才算載入完成
  function waitForStableCards(cb) {
    let last = -2;
    let sameCount = 0;
    const start = Date.now();
    const timer = setInterval(() => {
      const n = findAllCardTitleEls().length;
      if (n === last) sameCount++; else { sameCount = 0; last = n; }
      if (sameCount >= 2) {
        clearInterval(timer);
        cb(findAllCardTitleEls());
      } else if (Date.now() - start > 15000) {
        clearInterval(timer);
        cb(findAllCardTitleEls());
      }
    }, 800);
  }

  // ------------------------------------------------------------------
  // 清單頁：控制面板
  // ------------------------------------------------------------------
  function injectControlPanel() {
    if (document.getElementById('lpd-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'lpd-panel';
    panel.style.cssText = 'position:fixed;top:80px;left:20px;z-index:99999;' +
      'background:#fff;border:2px solid #9C27B0;border-radius:8px;padding:12px;' +
      'font-size:14px;box-shadow:0 2px 10px rgba(0,0,0,.2);width:270px;';

    panel.innerHTML = `
      <div style="font-weight:bold;margin-bottom:8px;">依商品清單下載貼文首圖</div>
      <div style="margin-bottom:8px;">
        商品清單(一行一個，可含日期/價格/emoji)：<br>
        <textarea id="lpd-keyword-textarea" rows="7" placeholder="例如：&#10;⭕️ 260929-多功能不鏽鋼水果刀 $35&#10;⭕️ 261003-韓國熱銷毛巾 $99" style="width:240px;resize:vertical;"></textarea>
      </div>
      <div style="margin-bottom:8px;">
        子資料夾(可留空)：<br>
        <input id="lpd-subfolder-input" type="text" placeholder="例如：到貨圖片" style="width:150px;">
      </div>
      <div id="lpd-status" style="margin-bottom:8px;color:#666;">尚未開始</div>
      <div id="lpd-unmatched" style="margin-bottom:8px;color:#E6A23C;font-size:12px;display:none;"></div>
      <button id="lpd-start-btn" style="background:#9C27B0;color:#fff;border:none;padding:6px 10px;border-radius:4px;cursor:pointer;margin-right:6px;">搜尋並下載</button>
      <button id="lpd-stop-btn" style="background:#F56C6C;color:#fff;border:none;padding:6px 10px;border-radius:4px;cursor:pointer;">停止</button>
      <div style="margin-top:8px;font-size:10px;color:#aaa;">版本：${(typeof GM_info !== 'undefined' && GM_info.script) ? GM_info.script.version : '未知'}</div>
    `;
    document.body.appendChild(panel);

    document.getElementById('lpd-start-btn').addEventListener('click', () => {
      const rawText = document.getElementById('lpd-keyword-textarea').value || '';
      const lines = rawText.split('\n').map(s => s.trim()).filter(s => s.length > 0);

      const seen = new Set();
      const kws = [];
      lines.forEach(raw => {
        const name = cleanKeyword(raw);
        if (!name || seen.has(name)) return;
        seen.add(name);
        kws.push({ raw, name, fallback: fallbackKeyword(name) });
      });

      if (kws.length === 0) {
        alert('請先輸入至少一個商品名稱（一行一個）。');
        return;
      }

      console.log('[LPD] 清洗後的搜尋字串：', kws.map(k => k.name));

      const subfolder = (document.getElementById('lpd-subfolder-input').value || '').trim();
      GM_setValue(K.subfolder, subfolder);
      GM_setValue(K.kwList, JSON.stringify(kws));
      GM_setValue(K.kwIndex, 0);
      GM_setValue(K.kwAttempt, 0);
      GM_setValue(K.resIndex, 0);
      GM_setValue(K.resTotal, -1);
      GM_setValue(K.notFound, '[]');
      GM_setValue(K.fallbackUsed, '[]');
      GM_setValue(K.doneCount, 0);
      GM_setValue(K.failCount, 0);
      GM_setValue(K.active, 'yes');
      GM_setValue(K.fbDone, 'no');
      GM_setValue(K.leaderTabId, TAB_ID);
      setStep(STEP.NEED_SEARCH);
      runListPageLogic();
    });

    document.getElementById('lpd-stop-btn').addEventListener('click', () => {
      listBusy = false;
      stopBatch('已停止。');
    });
  }

  function updatePanelStatus() {
    const statusEl = document.getElementById('lpd-status');
    const unEl = document.getElementById('lpd-unmatched');
    if (!statusEl) return;

    const notFound = getJson(K.notFound, []);
    const fb = getJson(K.fallbackUsed, []);
    let msg = '';
    if (notFound.length > 0) msg += '搜尋不到：' + notFound.join('、');
    if (fb.length > 0) msg += (msg ? '\n' : '') + '改用簡短字串搜尋(請人工確認圖片)：' + fb.join('、');
    if (unEl) {
      unEl.style.display = msg ? 'block' : 'none';
      unEl.style.whiteSpace = 'pre-wrap';
      unEl.textContent = msg;
    }

    if (!isActive()) {
      statusEl.textContent = '尚未開始';
      return;
    }
    const kws = getJson(K.kwList, []);
    const ki = GM_getValue(K.kwIndex, 0);
    const done = GM_getValue(K.doneCount, 0);
    const fail = GM_getValue(K.failCount, 0);
    const cur = kws[ki] ? kws[ki].name : '';
    statusEl.textContent = `進行中：第 ${Math.min(ki + 1, kws.length)} / ${kws.length} 個（${cur}）成功 ${done}，失敗 ${fail}`;
  }

  // ------------------------------------------------------------------
  // 清單頁邏輯：搜尋關鍵字 → 點搜尋結果卡片
  // ------------------------------------------------------------------
  let listBusy = false;

  function nextKeyword() {
    GM_setValue(K.kwIndex, GM_getValue(K.kwIndex, 0) + 1);
    GM_setValue(K.kwAttempt, 0);
    GM_setValue(K.resIndex, 0);
    GM_setValue(K.resTotal, -1);
  }

  function finishAll() {
    const kws = getJson(K.kwList, []);
    const done = GM_getValue(K.doneCount, 0);
    const fail = GM_getValue(K.failCount, 0);
    const notFound = getJson(K.notFound, []);
    const fb = getJson(K.fallbackUsed, []);
    let msg = `全部完成！共 ${kws.length} 個關鍵字，成功下載 ${done} 張，失敗 ${fail} 筆。`;
    if (notFound.length > 0) msg += '\n\n搜尋不到：\n' + notFound.join('\n');
    if (fb.length > 0) msg += '\n\n改用簡短字串搜尋(請人工確認圖片是否正確)：\n' + fb.join('\n');
    stopBatch(msg);
  }

  function runListPageLogic() {
    if (!isActive() || getStep() !== STEP.NEED_SEARCH) return;
    if (!isLeaderTab() || listBusy) return;

    const kws = getJson(K.kwList, []);
    const ki = GM_getValue(K.kwIndex, 0);
    if (ki >= kws.length) { finishAll(); return; }

    const kw = kws[ki];
    const attempt = GM_getValue(K.kwAttempt, 0);
    const term = (attempt === 1 && kw.fallback) ? kw.fallback : kw.name;
    const resIndex = GM_getValue(K.resIndex, 0);

    listBusy = true;

    waitFor(findSearchInput, 15000, (input) => {
      if (!input) {
        listBusy = false;
        stopBatch('找不到搜尋欄，批次中止。請確認目前在「開團一覽」頁面。');
        return;
      }
      delay(() => {
        setNativeValue(input, term);
        delay(() => {
          const btn = findSearchButton();
          if (!btn) {
            listBusy = false;
            stopBatch('找不到「搜尋」按鈕，批次中止。');
            return;
          }
          btn.click();
          // 等頁面送出搜尋並更新結果
          delay(() => {
            waitForStableCards((cards) => handleSearchResult(cards, kw, attempt, resIndex));
          }, 2000, 3000);
        }, 600, 1200);
      }, 800, 1800);
    });
  }

  function handleSearchResult(cards, kw, attempt, resIndex) {
    let resTotal = GM_getValue(K.resTotal, -1);

    if (resTotal === -1) {
      if (cards.length === 0) {
        // 完整名稱搜不到 → 改用備用短字串再搜一次
        if (attempt === 0 && kw.fallback) {
          GM_setValue(K.kwAttempt, 1);
          listBusy = false;
          return;
        }
        const nf = getJson(K.notFound, []);
        nf.push(kw.name);
        GM_setValue(K.notFound, JSON.stringify(nf));
        nextKeyword();
        listBusy = false;
        return;
      }
      if (attempt === 1) {
        // 備用字串可能比對到不相干的商品，只取第一筆，並提醒人工確認
        resTotal = 1;
        const fb = getJson(K.fallbackUsed, []);
        fb.push(kw.name);
        GM_setValue(K.fallbackUsed, JSON.stringify(fb));
      } else {
        resTotal = Math.min(cards.length, MAX_RESULTS_PER_KEYWORD);
      }
      GM_setValue(K.resTotal, resTotal);
    }

    if (resIndex >= resTotal || resIndex >= cards.length) {
      nextKeyword();
      listBusy = false;
      return;
    }

    const card = cards[resIndex];
    GM_setValue(K.curOrderTitle, getCardTitleText(card));
    setStep(STEP.WAIT_GO_TO_POST);
    listBusy = false;
    delay(() => card.click(), 1200, 2500);
  }

  // ------------------------------------------------------------------
  // 詳情頁邏輯
  // ------------------------------------------------------------------
  function runDetailPageLogic() {
    if (!isActive() || !isLeaderTab()) return;
    const step = getStep();

    if (step === STEP.WAIT_GO_TO_POST) {
      waitFor(findGoToPostButton, 15000, (btn) => {
        if (!btn) {
          GM_setValue(K.failCount, GM_getValue(K.failCount, 0) + 1);
          console.warn('[LPD] 找不到「前往貼文」按鈕，跳過這一筆：', GM_getValue(K.curOrderTitle, ''));
          advanceToNext();
          return;
        }
        GM_setValue(K.fbDone, 'no');
        setStep(STEP.WAITING_FB_TAB);
        delay(() => {
          btn.click();
          pollForFbDone();
        }, 1200, 2500);
      });
    } else if (step === STEP.WAITING_FB_TAB) {
      pollForFbDone();
    }
  }

  let pollingFb = false;
  function pollForFbDone() {
    if (pollingFb) return;
    pollingFb = true;
    const timer = setInterval(() => {
      if (!isActive()) { clearInterval(timer); pollingFb = false; return; }
      if (GM_getValue(K.fbDone, 'no') === 'yes') {
        clearInterval(timer);
        pollingFb = false;
        GM_setValue(K.fbDone, 'no');
        advanceToNext();
      }
    }, 1000);
  }

  function advanceToNext() {
    const ri = GM_getValue(K.resIndex, 0) + 1;
    const rt = GM_getValue(K.resTotal, -1);
    if (ri >= rt) {
      nextKeyword();
    } else {
      GM_setValue(K.resIndex, ri);
    }
    setStep(STEP.NEED_SEARCH);
    delay(() => {
      location.hash = '#/order/order/list';
    }, 1500, 3000);
  }

  // ------------------------------------------------------------------
  // FB頁面：找可見彈窗
  // ------------------------------------------------------------------
  function getVisibleDialog() {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
    const visible = dialogs.find(d => {
      const rect = d.getBoundingClientRect();
      return rect.width > 100 && rect.height > 100 && d.offsetParent !== null;
    });
    return visible || dialogs[0] || document.body;
  }

  // 在貼文範圍內找「第一張照片」，排除影片
  // 方法一(優先)：FB的照片會包在指向相片頁面的 <a href=".../photo/?fbid=..."> 裡；
  //   影片連結則是 ".../videos/..."，以連結網址區分照片與影片。
  // 方法二(備用)：img[data-visualcompletion="media-vc-image"]，並排除附近有<video>的。
  function findFirstPhotoImg(root) {
    const photoLinks = Array.from(root.querySelectorAll('a[href*="/photo/"], a[href*="/photo.php"], a[href*="fbid="]'))
      .filter(a => {
        const href = a.getAttribute('href') || '';
        return !href.includes('/videos/') && !href.includes('video_id=');
      });
    for (const a of photoLinks) {
      const img = a.querySelector('img');
      if (img && img.src) return img;
    }

    const imgs = Array.from(root.querySelectorAll('img[data-visualcompletion="media-vc-image"]'));
    for (const img of imgs) {
      let el = img;
      let isVideo = false;
      for (let i = 0; i < 5 && el; i++) {
        if (el.querySelector && el.querySelector('video')) { isVideo = true; break; }
        el = el.parentElement;
      }
      if (isVideo) continue;

      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (w < 150 && h < 150) continue;

      return img;
    }
    return null;
  }

  function sanitizeFilename(name) {
    return (name || 'photo').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 100);
  }

  function runFacebookLogic() {
    if (!isActive() || getStep() !== STEP.WAITING_FB_TAB) return;
    if (window.__lpdFbStarted) return;
    window.__lpdFbStarted = true;

    delay(() => {
      const root = getVisibleDialog();
      const img = findFirstPhotoImg(root);

      if (!img || !img.src) {
        console.warn('[LPD] 這則貼文找不到符合條件的照片(可能整篇都是影片，或版面辨識不到)：', GM_getValue(K.curOrderTitle, ''));
        GM_setValue(K.failCount, GM_getValue(K.failCount, 0) + 1);
        finishAndClose();
        return;
      }

      const title = GM_getValue(K.curOrderTitle, 'photo');
      const subfolder = (GM_getValue(K.subfolder, '') || '').trim();
      // name 含 "子資料夾/檔名" 時，Chrome 會在目前的下載資料夾底下自動建立該子資料夾
      const safeSubfolder = subfolder ? sanitizeFilename(subfolder) + '/' : '';
      const filename = safeSubfolder + sanitizeFilename(title) + '.jpg';

      console.log('[LPD] 準備下載：', filename, img.src);

      try {
        GM_download({
          url: img.src,
          name: filename,
          saveAs: false,
          onload: () => {
            console.log('[LPD] 下載完成：', filename);
            GM_setValue(K.doneCount, GM_getValue(K.doneCount, 0) + 1);
            finishAndClose();
          },
          onerror: (err) => {
            console.warn('[LPD] 下載失敗：', filename, err);
            GM_setValue(K.failCount, GM_getValue(K.failCount, 0) + 1);
            finishAndClose();
          },
        });
      } catch (e) {
        console.warn('[LPD] GM_download 執行時發生錯誤：', e);
        GM_setValue(K.failCount, GM_getValue(K.failCount, 0) + 1);
        finishAndClose();
      }
    }, 4000, 6500);
  }

  function finishAndClose() {
    GM_setValue(K.fbDone, 'yes');
    delay(() => {
      try { window.close(); } catch (e) { /* 若瀏覽器不允許自動關閉，分頁會留著，手動關掉即可 */ }
    }, 1200, 2500);
  }

  // ------------------------------------------------------------------
  // 路由判斷
  // ------------------------------------------------------------------
  function routeDispatch() {
    if (location.hostname.includes('facebook.com')) {
      runFacebookLogic();
      return;
    }

    if (!location.hostname.includes('likedoa.com')) return;

    if (location.hash.includes('/order/order/list')) {
      injectControlPanel();
      updatePanelStatus();
      runListPageLogic();
    } else {
      listBusy = false;
      const oldPanel = document.getElementById('lpd-panel');
      if (oldPanel) oldPanel.remove();

      if (location.hash.includes('/order/order/detail')) {
        runDetailPageLogic();
      }
    }
  }

  routeDispatch();
  window.addEventListener('hashchange', routeDispatch);
  setInterval(routeDispatch, 1500);
})();
