// ==UserScript==
// @name         B站每日任务助手 · 自动完成每日奖励
// @version      2.0.1
// @description  自动完成哔哩哔哩网页版每日任务：观看视频、分享视频、投币；面板实时显示经验值与升级天数预测。
// @author       Momomo
// @license      MIT
// @homepageURL  https://greasyfork.org/zh-CN/scripts/601799-b%E7%AB%99%E6%AF%8F%E6%97%A5%E4%BB%BB%E5%8A%A1%E5%8A%A9%E6%89%8B-%E8%87%AA%E5%8A%A8%E5%AE%8C%E6%88%90%E6%AF%8F%E6%97%A5%E5%A5%96%E5%8A%B1
// @supportURL   https://greasyfork.org/zh-CN/scripts/601799/feedback
// @updateURL    https://update.greasyfork.org/scripts/601799/B%E7%AB%99%E6%AF%8F%E6%97%A5%E4%BB%BB%E5%8A%A1%E5%8A%A9%E6%89%8B%20%C2%B7%20%E8%87%AA%E5%8A%A8%E5%AE%8C%E6%88%90%E6%AF%8F%E6%97%A5%E5%A5%96%E5%8A%B1.meta.js
// @downloadURL  https://update.greasyfork.org/scripts/601799/B%E7%AB%99%E6%AF%8F%E6%97%A5%E4%BB%BB%E5%8A%A1%E5%8A%A9%E6%89%8B%20%C2%B7%20%E8%87%AA%E5%8A%A8%E5%AE%8C%E6%88%90%E6%AF%8F%E6%97%A5%E5%A5%96%E5%8A%B1.user.js
// @namespace    https://github.com/Momomo79/bili-daily-helper
// @match        https://www.bilibili.com/*
// @match        https://space.bilibili.com/*
// @match        https://t.bilibili.com/*
// @match        https://account.bilibili.com/*
// @match        https://message.bilibili.com/*
// @icon         https://www.bilibili.com/favicon.ico
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @connect      bilibili.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  if (window.__BDH_LOADED__) return;
  window.__BDH_LOADED__ = true;

  const VERSION = '2.0.1';
  const NS = 'bili-daily-helper';
  const KEY_CFG = NS + ':cfg';
  const KEY_STATE = NS + ':state';
  const KEY_POS = NS + ':pos';
  const KEY_EXP = NS + ':exp';
  const DAILY_MAX_EXP = 65;

  const DEFAULT_CONFIG = {
    enableWatch: true,
    enableShare: true,
    enableCoin: true,
    watchSeconds: 60,
    coinExpTarget: 50,
    selectLike: false,
    autoRun: true,
    maxRunsPerDay: 2,
    panelRight: 16,
    panelBottom: 16
  };

  const API = {
    nav: 'https://api.bilibili.com/x/web-interface/nav',
    reward: 'https://api.bilibili.com/x/member/web/exp/reward',
    share: 'https://api.bilibili.com/x/web-interface/share/add',
    coinAdd: 'https://api.bilibili.com/x/web-interface/coin/add',
    coinState: 'https://api.bilibili.com/x/web-interface/archive/coins',
    ranking: 'https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all',
    popular: 'https://api.bilibili.com/x/web-interface/popular',
    toview: 'https://api.bilibili.com/x/v2/history/toview'
  };

  const timeFmt = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const numFmt = new Intl.NumberFormat('zh-CN');

  const store = {
    get(key, def) {
      try {
        if (typeof GM_getValue === 'function') {
          const v = GM_getValue(key);
          if (v !== undefined && v !== null) return typeof v === 'string' ? safeParse(v, v) : v;
        }
      } catch (e) {}
      try {
        const s = localStorage.getItem(key);
        if (s) return safeParse(s, s);
      } catch (e) {}
      return def;
    },
    set(key, val) {
      try {
        if (typeof GM_setValue === 'function') { GM_setValue(key, val); return; }
      } catch (e) {}
      try { localStorage.setItem(key, typeof val === 'string' ? val : JSON.stringify(val)); } catch (e) {}
    }
  };

  function safeParse(s, def) {
    try { return JSON.parse(s); } catch (e) { return def; }
  }

  let cfg = Object.assign({}, DEFAULT_CONFIG, store.get(KEY_CFG, {}) || {});
  if (cfg.coinCount !== undefined) {
    cfg.coinExpTarget = Math.max(0, Math.min(5, Number(cfg.coinCount) || 0)) * 10;
    delete cfg.coinCount;
  }
  delete cfg.enableLiveSign;
  function saveConfig() { store.set(KEY_CFG, cfg); }

  const state = {
    running: false,
    aborted: false,
    counted: false,
    signal: null,
    videos: null,
    tasks: {}
  };

  let logQueue = [];
  let logRaf = 0;

  function log(msg) {
    try { console.log('[B站每日任务]', msg); } catch (e) {}
    logQueue.push(`[${timeFmt.format(new Date())}] ${msg}`);
    if (logQueue.length > 300) logQueue.splice(0, logQueue.length - 300);
    if (!logRaf) logRaf = requestAnimationFrame(flushLog);
  }

  function flushLog() {
    logRaf = 0;
    if (!logQueue.length) return;
    const lines = logQueue;
    logQueue = [];
    if (panel) panel.appendLogs(lines);
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      if (state.aborted) return resolve();
      const sig = state.signal;
      const done = () => {
        clearTimeout(timer);
        if (sig) sig.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      if (sig) sig.addEventListener('abort', done, { once: true });
    });
  }

  function waitFor(fn, timeout = 15000, interval = 300) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        if (state.aborted) return reject(new Error('已停止'));
        let v = null;
        try { v = fn(); } catch (e) { v = null; }
        if (v) return resolve(v);
        if (Date.now() - started > timeout) return reject(new Error('等待超时'));
        setTimeout(tick, interval);
      };
      tick();
    });
  }

  function idle(fn) {
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(fn, { timeout: 2500 });
    else setTimeout(fn, 220);
  }

  function short(t, n = 18) {
    const s = String(t || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n) + '…' : (s || '(无标题)');
  }

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  const BVT = 'fZodR9XQDSUm21yCkr6zBqiveYah8bt4xsWpHnJE7jL5VG3guMTKNPAwcF';
  const BVS = [11, 10, 3, 8, 4, 6];
  const BV_XOR = 177451812;
  const BV_ADD = 8728348608;

  function av2bv(aid) {
    let x = (Number(aid) ^ BV_XOR) + BV_ADD;
    const r = ['B', 'V', '1', ' ', ' ', '4', ' ', '1', ' ', '7', ' ', ' '];
    for (let i = 0; i < 6; i++) r[BVS[i]] = BVT[Math.floor(x / Math.pow(58, i)) % 58];
    return r.join('');
  }

  function getCsrf() {
    const m = document.cookie.match(/(?:^|;\s*)bili_jct=([^;]+)/);
    return m ? m[1] : '';
  }

  function toForm(obj) {
    return Object.keys(obj || {})
      .filter((k) => obj[k] !== undefined && obj[k] !== null)
      .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]))
      .join('&');
  }

  function request(method, url, params) {
    const isPost = method.toUpperCase() !== 'GET';
    const body = isPost ? toForm(params) : null;
    const full = (!isPost && params) ? url + (url.indexOf('?') >= 0 ? '&' : '?') + toForm(params) : url;
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 20000) : null;

    const viaFetch = () => fetch(full, {
      method: isPost ? 'POST' : 'GET',
      credentials: 'include',
      signal: ctrl ? ctrl.signal : undefined,
      headers: isPost ? { 'Content-Type': 'application/x-www-form-urlencoded' } : undefined,
      body: isPost ? body : undefined
    }).then((r) => r.text()).then((txt) => {
      try { return JSON.parse(txt); } catch (e) { throw new Error('接口返回异常'); }
    });

    return viaFetch().catch((err) => {
      if (err && err.name === 'AbortError') throw new Error('请求超时');
      if (typeof GM_xmlhttpRequest !== 'function') throw err;
      return new Promise((resolve, reject) => {
        const headers = { Referer: 'https://www.bilibili.com/' };
        if (isPost) headers['Content-Type'] = 'application/x-www-form-urlencoded';
        GM_xmlhttpRequest({
          method: isPost ? 'POST' : 'GET',
          url: full,
          data: body || undefined,
          timeout: 20000,
          headers,
          onload: (res) => {
            try { resolve(JSON.parse(res.responseText)); } catch (e) { reject(new Error('接口返回异常')); }
          },
          onerror: () => reject(new Error('网络错误')),
          ontimeout: () => reject(new Error('请求超时'))
        });
      });
    }).finally(() => { if (timer) clearTimeout(timer); });
  }

  async function navInfo() {
    const r = await request('GET', API.nav);
    if (!r || r.code !== 0 || !r.data) throw new Error('登录状态接口返回异常');
    return r.data;
  }

  let rewardCache = { at: 0, val: null };

  function readRewardPanel(force) {
    const now = Date.now();
    if (!force && rewardCache.val && now - rewardCache.at < 1200) return rewardCache.val;
    const labels = ['每日登录', '每日观看视频', '每日投币', '每日分享视频'];
    const res = {};
    let found = 0;
    const root = document.body || document.documentElement;
    let walker = null;
    try {
      walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    } catch (e) { walker = null; }
    let node = walker ? walker.nextNode() : null;
    let steps = 0;
    while (node && found < 4 && steps < 60000) {
      steps++;
      const cur = node;
      node = walker.nextNode();
      const raw = cur.nodeValue;
      if (!raw || raw.length > 26) continue;
      const txt = raw.replace(/\s+/g, '');
      if (!txt) continue;
      let hit = null;
      for (let j = 0; j < labels.length; j++) {
        if (txt.indexOf(labels[j]) === 0) { hit = labels[j]; break; }
      }
      if (!hit || res[hit]) continue;
      let box = cur.parentElement;
      if (!box) continue;
      let info = '';
      for (let k = 0; k < 4 && box; k++) {
        const bt = (box.textContent || '').replace(/\s+/g, '');
        let multi = 0;
        for (let j = 0; j < labels.length; j++) if (bt.indexOf(labels[j]) >= 0) multi++;
        if (multi > 1) break;
        if (/已获得\d+\/\d+|经验值到手|已完成/.test(bt)) { info = bt; break; }
        box = box.parentElement;
      }
      if (!info) continue;
      found++;
      const m = info.match(/已获得(\d+)\/(\d+)/);
      if (m) res[hit] = { done: Number(m[1]) >= Number(m[2]), exp: Number(m[1]), target: Number(m[2]) };
      else res[hit] = { done: /经验值到手|已完成/.test(info), exp: null, target: null };
    }
    const val = found ? res : null;
    rewardCache = { at: now, val };
    return val;
  }

  async function readTasks() {
    const r = await request('GET', API.reward);
    if (!r || r.code !== 0) throw new Error(`状态接口返回 ${r && r.code} ${(r && r.message) || ''}`);
    const d = r.data || {};
    const out = {
      login: !!d.login,
      watch: !!d.watch,
      share: !!d.share,
      coins: Number(d.coins != null ? d.coins : (d.coin || 0)) || 0,
      raw: d
    };
    const dom = readRewardPanel();
    if (dom) {
      if (dom['每日登录'] && dom['每日登录'].done) out.login = true;
      if (dom['每日观看视频'] && dom['每日观看视频'].done) out.watch = true;
      if (dom['每日分享视频'] && dom['每日分享视频'].done) out.share = true;
    }
    return out;
  }

  function coinProgress(st) {
    const raw = Number(cfg.coinExpTarget);
    const target = Math.max(0, Math.min(50, Math.round((Number.isFinite(raw) ? raw : 50) / 10) * 10));
    let exp = null;
    const dom = readRewardPanel();
    if (dom && dom['每日投币'] && Number.isFinite(dom['每日投币'].exp)) exp = dom['每日投币'].exp;
    if (exp === null && st) exp = Math.min(50, (Number(st.coins) || 0) * 10);
    if (exp === null) exp = 0;
    return { exp, target, need: Math.max(0, Math.ceil((target - exp) / 10)) };
  }

  let expInfo = null;

  function applyExp(data) {
    const li = (data && data.level_info) || {};
    const info = {
      level: Number(li.current_level) || 0,
      exp: Number(li.current_exp) || 0,
      min: Number(li.current_min) || 0,
      next: Number(li.next_exp) || 0,
      uname: (data && data.uname) || '',
      at: Date.now()
    };
    expInfo = info;
    store.set(KEY_EXP, info);
    return info;
  }

  function expSummary(info, st) {
    if (!info) return null;
    const max = !info.next || info.next <= info.exp || info.level >= 6;
    const remain = max ? 0 : Math.max(0, info.next - info.exp);
    let todayLeft = DAILY_MAX_EXP;
    if (st) {
      todayLeft = 0;
      if (!st.login) todayLeft += 5;
      if (!st.watch) todayLeft += 5;
      if (!st.share) todayLeft += 5;
      todayLeft += Math.max(0, 50 - Math.min(50, (Number(st.coins) || 0) * 10));
    }
    const days = max ? 0 : Math.max(1, Math.ceil(Math.max(0, remain - todayLeft) / DAILY_MAX_EXP) + (todayLeft > 0 ? 1 : 0));
    return {
      max,
      remain,
      todayLeft,
      days,
      ratio: max ? 1 : Math.min(1, info.exp / info.next)
    };
  }

  function refreshExp(st, silent) {
    return navInfo().then((d) => {
      if (!d.isLogin) throw new Error('未登录');
      const info = applyExp(d);
      if (panel) panel.renderExp(info, st || null);
      return info;
    }).catch((e) => {
      if (!silent) log('⚠️ 经验值读取失败：' + e.message);
      if (panel) panel.renderExp(expInfo, st || null);
      return null;
    });
  }

  async function doShare(v) {
    const csrf = getCsrf();
    if (!csrf) throw new Error('拿不到 bili_jct，请确认已登录');
    return request('POST', API.share, { aid: v.aid, bvid: v.bvid, csrf });
  }

  async function doCoin(v, multiply) {
    const csrf = getCsrf();
    if (!csrf) throw new Error('拿不到 bili_jct，请确认已登录');
    return request('POST', API.coinAdd, {
      aid: v.aid,
      multiply,
      select_like: cfg.selectLike ? 1 : 0,
      csrf
    });
  }

  async function coinState(aid) {
    try {
      const r = await request('GET', API.coinState, { aid, type: 1 });
      if (r && r.code === 0 && r.data) return Number(r.data.multiply || 0);
    } catch (e) {}
    return null;
  }

  async function collectVideos() {
    const out = [];
    const seen = new Set();
    const push = (v) => {
      const id = Number(v && v.aid);
      if (!id || seen.has(id)) return;
      seen.add(id);
      out.push({ aid: id, bvid: v.bvid || av2bv(id), title: v.title || '', owner: (v.owner && v.owner.name) || '' });
    };
    const results = await Promise.allSettled([
      request('GET', API.ranking),
      request('GET', API.popular, { ps: 30, pn: 1 }),
      request('GET', API.toview)
    ]);
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const data = r.value && r.value.code === 0 ? r.value.data : null;
      if (data && Array.isArray(data.list)) data.list.forEach(push);
    }
    return shuffle(out);
  }

  async function ensureVideos() {
    if (state.videos && state.videos.length) return state.videos;
    state.videos = await collectVideos();
    if (!state.videos.length) throw new Error('没有取到可用的视频列表（可能是接口变动或未登录）');
    return state.videos;
  }

  async function watchTask(seconds) {
    if (location.hostname !== 'www.bilibili.com') {
      throw new Error('观看任务需要在 www.bilibili.com 页面执行');
    }
    const vids = await ensureVideos();
    let lastErr = null;
    for (const v of vids.slice(0, 3)) {
      if (state.aborted) throw new Error('已停止');
      try {
        await playInFrame(v, seconds);
        return v;
      } catch (e) {
        lastErr = e;
        log(`… 播放失败，换下一个：${e.message}`);
      }
    }
    throw lastErr || new Error('播放失败');
  }

  async function playInFrame(v, seconds) {
    const url = `https://www.bilibili.com/video/${v.bvid}/`;
    log(`▶️ 后台播放：${short(v.title)}`);
    const frame = document.createElement('iframe');
    frame.setAttribute('allow', 'autoplay; encrypted-media');
    frame.style.cssText = 'position:fixed;left:-9999px;top:0;width:800px;height:450px;border:0;opacity:0;pointer-events:none;';
    frame.src = url;
    document.body.appendChild(frame);

    try {
      const video = await waitFor(() => {
        let doc = null;
        try { doc = frame.contentDocument; } catch (e) { return null; }
        if (!doc) return null;
        const el = doc.querySelector('video');
        return el && el.readyState >= 1 ? el : null;
      }, 25000, 400);

      video.muted = true;
      video.volume = 0;
      try { await video.play(); } catch (e) { log('⚠️ 自动播放被浏览器拦了，正在重试…'); }

      const started = Date.now();
      let lastPos = -1;
      let stall = 0;
      while (Date.now() - started < seconds * 1000) {
        if (state.aborted) throw new Error('已停止');
        await sleep(1000);
        if (state.aborted) throw new Error('已停止');
        const pos = video.currentTime || 0;
        const elapsed = Math.floor((Date.now() - started) / 1000);
        setTask('watch', 'doing', `播放中 ${Math.min(seconds, elapsed)}/${seconds}s`);
        if (elapsed > 4 && Math.abs(pos - lastPos) < 0.05) stall++; else stall = 0;
        lastPos = pos;
        if (stall === 8) {
          stall = 0;
          log('⚠️ 播放进度没动：请切回本标签页，或允许后台标签页播放');
          try { await video.play(); } catch (e) {}
        }
      }
      try { video.pause(); } catch (e) {}
      log(`✅ 播放完成：${short(v.title)}`);
      return v;
    } finally {
      try { frame.remove(); } catch (e) {}
    }
  }

  async function runAll(reason) {
    if (state.running) { log('任务正在执行中，先等一下'); return; }

    state.running = true;
    state.aborted = false;
    state.counted = false;
    state.videos = null;
    const ac = new AbortController();
    state.signal = ac.signal;
    setRunningUI(true);
    resetTaskUI();
    log(`===== 开始执行（${reason}）=====`);

    try {
      setTask('login', 'doing', '检查中');
      let me = null;
      try { me = await navInfo(); } catch (e) { log('⚠️ 登录状态查询失败：' + e.message); }
      if (!me || !me.isLogin) {
        setTask('login', 'fail', '未登录');
        log('❌ 当前未登录，请先登录 B 站账号再执行');
        return;
      }
      state.counted = true;
      setTask('login', 'ok', '已登录');
      const info = applyExp(me);
      if (panel) panel.renderExp(info, null);

      let st = null;
      try { st = await readTasks(); } catch (e) { log('⚠️ 任务状态读取失败：' + e.message); }
      if (st) {
        const p0 = coinProgress(st);
        log(`当前状态：登录${st.login ? '√' : '×'} 观看${st.watch ? '√' : '×'} 分享${st.share ? '√' : '×'} 投币 ${p0.exp}/${p0.target} 经验`);
        setTask('watch', st.watch ? 'ok' : 'idle', st.watch ? '今日已完成' : '待执行');
        setTask('share', st.share ? 'ok' : 'idle', st.share ? '今日已完成' : '待执行');
        setTask('coin', st.coins > 0 ? 'ok' : 'idle', `投币经验 ${p0.exp}/${p0.target}`);
        if (expInfo) panel && panel.renderExp(expInfo, st);
      }

      if (cfg.enableShare && !state.aborted) {
        if (st && st.share) {
          setTask('share', 'ok', '今日已完成');
        } else {
          setTask('share', 'doing', '分享中');
          let ok = false;
          try {
            const vids = await ensureVideos();
            for (const v of vids.slice(0, 5)) {
              if (state.aborted) break;
              try {
                const r = await doShare(v);
                if (r && r.code === 0) { ok = true; log(`✅ 分享成功：${short(v.title)}`); break; }
                log(`… 分享被拒（${r && r.code} ${(r && r.message) || ''}），换下一个`);
              } catch (e) {
                log('… 分享出错：' + e.message);
              }
              await sleep(1200);
            }
          } catch (e) {
            log('❌ 分享出错：' + e.message);
          }
          setTask('share', ok ? 'ok' : 'fail', ok ? '分享成功' : '失败');
        }
      } else if (!cfg.enableShare) {
        setTask('share', 'skip', '已关闭');
      }

      if (cfg.enableCoin && !state.aborted) {
        const prog = coinProgress(st);
        if (prog.need <= 0) {
          setTask('coin', 'ok', `投币经验 ${prog.exp}/${prog.target}`);
          log(`投币已完成：${prog.exp}/${prog.target} 经验，无需再投`);
        } else {
          log(`投币：当前 ${prog.exp}/${prog.target} 经验，本次需要再投 ${prog.need} 枚`);
          setTask('coin', 'doing', `投币中 ${prog.exp}/${prog.target}`);
          let thrown = 0;
          try {
            const vids = await ensureVideos();
            for (const v of vids) {
              if (state.aborted || thrown >= prog.need) break;
              const had = await coinState(v.aid);
              if (had && had > 0) { log(`… 已投过币，跳过：${short(v.title)}`); continue; }
              const mult = Math.min(2, prog.need - thrown);
              try {
                const r = await doCoin(v, mult);
                if (r && r.code === 0) {
                  thrown += mult;
                  setTask('coin', 'doing', `投币中 ${Math.min(prog.target, prog.exp + thrown * 10)}/${prog.target}`);
                  log(`✅ 投币 ${mult} 枚：${short(v.title)}`);
                } else {
                  log(`… 投币失败（${r && r.code} ${(r && r.message) || ''}）：${short(v.title)}`);
                }
              } catch (e) {
                log('… 投币出错：' + e.message);
              }
              await sleep(1500);
            }
          } catch (e) {
            log('❌ 投币流程出错：' + e.message);
          }
          setTask('coin', thrown > 0 ? 'ok' : 'fail', thrown > 0 ? `本次投币 ${thrown} 枚（+${thrown * 10} 经验）` : '失败');
        }
      } else if (!cfg.enableCoin) {
        setTask('coin', 'skip', '已关闭');
      }

      if (cfg.enableWatch && !state.aborted) {
        if (st && st.watch) {
          setTask('watch', 'ok', '今日已完成');
        } else {
          setTask('watch', 'doing', '准备播放');
          try {
            await watchTask(Math.max(10, Math.min(600, Number(cfg.watchSeconds) || 60)));
            setTask('watch', 'ok', '播放完成');
          } catch (e) {
            setTask('watch', 'fail', state.aborted ? '已停止' : '失败');
            log('❌ 观看视频任务：' + e.message);
          }
        }
      } else if (!cfg.enableWatch) {
        setTask('watch', 'skip', '已关闭');
      }

      if (!state.aborted) {
        await sleep(1200);
        try {
          const st2 = await readTasks();
          const p2 = coinProgress(st2);
          log(`执行后状态：登录${st2.login ? '√' : '×'} 观看${st2.watch ? '√' : '×'} 分享${st2.share ? '√' : '×'} 投币 ${p2.exp}/${p2.target} 经验`);
          setTask('login', st2.login ? 'ok' : 'fail', st2.login ? '已登录' : '未登录');
          if (cfg.enableWatch) setTask('watch', st2.watch ? 'ok' : 'fail', st2.watch ? '今日已完成' : '未完成');
          if (cfg.enableShare) setTask('share', st2.share ? 'ok' : 'fail', st2.share ? '今日已完成' : '未完成');
          if (cfg.enableCoin) setTask('coin', p2.need <= 0 ? 'ok' : 'fail', `投币经验 ${p2.exp}/${p2.target}`);
          await refreshExp(st2, true);
        } catch (e) {
          log('⚠️ 复查失败：' + e.message);
        }
      }

      log(state.aborted ? '===== 已停止 =====' : '===== 本轮执行结束 =====');
    } catch (e) {
      log('❌ 执行中断：' + (e && e.message ? e.message : e));
    } finally {
      if (state.counted) {
        const s = loadDailyState();
        s.runs = (s.runs || 0) + 1;
        s.lastAt = Date.now();
        store.set(KEY_STATE, s);
      }
      state.running = false;
      state.signal = null;
      setRunningUI(false);
      notifyDone();
    }
  }

  function stopAll() {
    if (!state.running) return;
    state.aborted = true;
    log('⏹ 已请求停止…');
  }

  function loadDailyState() {
    const s = store.get(KEY_STATE, null) || {};
    if (s.date !== todayKey()) return { date: todayKey(), runs: 0 };
    return s;
  }

  function notifyDone() {
    if (typeof GM_notification !== 'function') return;
    const keys = Object.keys(state.tasks);
    const failed = keys.filter((k) => state.tasks[k] && state.tasks[k].status === 'fail');
    const ok = keys.filter((k) => state.tasks[k] && state.tasks[k].status === 'ok');
    if (!ok.length) return;
    try {
      GM_notification({
        title: 'B站每日任务 · 执行结束',
        text: failed.length ? `已完成 ${ok.length} 项，失败 ${failed.length} 项` : '全部任务已完成',
        timeout: 6000
      });
    } catch (e) {}
  }

  const TASK_DEFS = [
    { key: 'login', label: '登录状态' },
    { key: 'watch', label: '观看视频' },
    { key: 'share', label: '分享视频' },
    { key: 'coin', label: '投币' }
  ];

  const ICON = {
    cfg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h8M16 7h4M4 17h4M12 17h8"/><circle cx="14" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>',
    min: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 12h14"/></svg>',
    hide: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    sync: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v5h-5"/></svg>'
  };

  const PANEL_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif; }
    .panel, .fab {
      --bg: #ffffff;
      --soft: #f6f7f9;
      --soft2: #eceef2;
      --fg: #101318;
      --fg2: #5b6270;
      --fg3: #8f95a3;
      --line: #eaecf0;
      --accent: #fb7299;
      --accent2: #8b6cff;
      --ok: #12b76a;
      --warn: #f79009;
      --err: #f04438;
    }
    @media (prefers-color-scheme: dark) {
      .panel, .fab {
        --bg: #16181d;
        --soft: #1d2027;
        --soft2: #272b34;
        --fg: #eceef3;
        --fg2: #a4abba;
        --fg3: #737b8b;
        --line: #2a2e37;
      }
    }
    .panel {
      width: 302px; background: var(--bg); color: var(--fg);
      border: 1px solid var(--line); border-radius: 16px;
      box-shadow: 0 2px 6px rgba(16,19,24,.05), 0 22px 48px -22px rgba(16,19,24,.45);
      overflow-x: hidden; overflow-y: auto; max-height: calc(100vh - 24px);
      font-size: 12px; line-height: 1.5; user-select: none;
      -webkit-font-smoothing: antialiased;
    }
    .panel::-webkit-scrollbar { width: 5px; }
    .panel::-webkit-scrollbar-thumb { background: var(--soft2); border-radius: 3px; }
    .head { display: flex; align-items: center; gap: 7px; padding: 13px 12px 10px 14px; cursor: move; }
    .logo { width: 19px; height: 19px; border-radius: 6px; flex: 0 0 auto; background: linear-gradient(135deg, var(--accent), var(--accent2)); box-shadow: 0 4px 10px -4px rgba(251,114,153,.85); }
    .logo.sm { width: 7px; height: 7px; border-radius: 50%; box-shadow: none; background: #cbd0d9; }
    .title { flex: 1; font-size: 12.5px; font-weight: 600; letter-spacing: .01em; white-space: nowrap; }
    .ver { font-size: 10px; color: var(--fg3); font-variant-numeric: tabular-nums; margin-right: 2px; }
    .ico { width: 22px; height: 22px; display: grid; place-items: center; border: 0; border-radius: 7px; background: transparent; color: var(--fg3); cursor: pointer; transition: background .15s, color .15s; }
    .ico:hover { background: var(--soft); color: var(--fg); }
    .ico svg { width: 13px; height: 13px; }
    .exp { margin: 0 14px 10px; padding: 11px 12px 10px; border-radius: 12px; background: var(--soft); border: 1px solid var(--line); }
    .exp-top { display: flex; align-items: center; gap: 8px; margin-bottom: 9px; }
    .lv { flex: 0 0 auto; padding: 2px 7px; border-radius: 999px; font-size: 10.5px; font-weight: 700; letter-spacing: .04em; color: #fff; background: linear-gradient(135deg, var(--accent), var(--accent2)); font-variant-numeric: tabular-nums; }
    .exp-num { flex: 1; text-align: right; font-size: 11.5px; color: var(--fg2); font-variant-numeric: tabular-nums; }
    .mini { width: 18px; height: 18px; display: grid; place-items: center; border: 0; border-radius: 6px; background: transparent; color: var(--fg3); cursor: pointer; transition: background .15s, color .15s; }
    .mini:hover { background: var(--soft2); color: var(--fg); }
    .mini svg { width: 12px; height: 12px; }
    .bar { height: 6px; border-radius: 999px; background: rgba(140,148,166,.2); overflow: hidden; }
    .bar i { display: block; height: 100%; width: 0; border-radius: 999px; background: linear-gradient(90deg, var(--accent), var(--accent2)); transition: width .55s cubic-bezier(.4,0,.2,1); }
    .exp-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; font-size: 10.5px; color: var(--fg3); }
    .exp-foot .hint { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .days { flex: 0 0 auto; font-weight: 600; color: var(--accent); font-variant-numeric: tabular-nums; }
    .exp[data-s="max"] .days { color: var(--ok); }
    .tasks { padding: 0 7px 2px; }
    .task { display: flex; align-items: center; gap: 8px; padding: 6px 7px; border-radius: 9px; transition: background .15s; }
    .task:hover { background: var(--soft); }
    .dot { width: 6px; height: 6px; border-radius: 50%; background: #cbd0d9; flex: 0 0 auto; }
    .task .name { flex: 1; color: var(--fg2); }
    .task .st { font-size: 10.5px; color: var(--fg3); max-width: 156px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .task[data-s="doing"] .dot { background: var(--warn); animation: pulse 1.1s ease-in-out infinite; }
    .task[data-s="doing"] .st { color: var(--warn); }
    .task[data-s="ok"] .dot { background: var(--ok); }
    .task[data-s="ok"] .st { color: var(--ok); }
    .task[data-s="fail"] .dot { background: var(--err); }
    .task[data-s="fail"] .st { color: var(--err); }
    .log { margin: 8px 14px 12px; height: 84px; overflow-y: auto; padding: 8px 10px; border-radius: 10px; background: var(--soft); color: var(--fg2); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 10.5px; line-height: 1.65; white-space: pre-wrap; word-break: break-word; user-select: text; }
    .log:not(:empty) { -webkit-mask-image: linear-gradient(180deg, transparent 0, #000 9px); mask-image: linear-gradient(180deg, transparent 0, #000 9px); }
    .log::-webkit-scrollbar { width: 4px; }
    .log::-webkit-scrollbar-thumb { background: var(--soft2); border-radius: 2px; }
    .log:empty::before { content: "等待执行…"; color: var(--fg3); }
    .actions { display: flex; gap: 7px; padding: 0 14px 13px; }
    .btn { flex: 1; height: 33px; border-radius: 9px; border: 1px solid var(--line); background: var(--soft); color: var(--fg); font-size: 12px; font-weight: 500; cursor: pointer; transition: background .15s, transform .1s; }
    .btn:hover { background: var(--soft2); }
    .btn:active { transform: scale(.985); }
    .btn.primary { flex: 1.4; border-color: transparent; background: linear-gradient(135deg, var(--accent), var(--accent2)); color: #fff; font-weight: 600; box-shadow: 0 8px 18px -10px rgba(251,114,153,.95); }
    .btn.primary:hover { filter: brightness(1.04); }
    .btn:disabled { opacity: .5; cursor: not-allowed; }
    .settings { display: none; padding: 0 14px 13px; }
    .settings.show { display: block; }
    .row { display: flex; align-items: center; justify-content: space-between; padding: 5px 0; color: var(--fg2); font-size: 11.5px; }
    .row input[type=checkbox] { width: 15px; height: 15px; accent-color: var(--accent); cursor: pointer; }
    .row input[type=number] { width: 58px; height: 24px; border: 1px solid var(--line); border-radius: 7px; background: var(--soft); color: var(--fg); font-size: 11px; text-align: center; font-variant-numeric: tabular-nums; }
    .tip { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--line); font-size: 10.5px; color: var(--fg3); line-height: 1.6; }
    .credit { margin-top: 6px; font-size: 10px; color: var(--fg3); opacity: .85; }
    .credit b { color: var(--fg2); font-weight: 600; }
    .fab { display: flex; align-items: center; gap: 7px; height: 34px; padding: 0 13px 0 12px; border-radius: 999px; background: var(--bg); border: 1px solid var(--line); box-shadow: 0 10px 26px -12px rgba(16,19,24,.55); color: var(--fg); font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap; transition: transform .16s, box-shadow .16s; }
    .fab:hover { transform: translateY(-1px); box-shadow: 0 14px 30px -12px rgba(16,19,24,.65); }
    .fab .badge { font-size: 10.5px; font-weight: 400; color: var(--fg3); font-variant-numeric: tabular-nums; }
    .fab[data-s="doing"] .logo.sm { background: var(--warn); animation: pulse 1.1s ease-in-out infinite; }
    .fab[data-s="ok"] .logo.sm { background: var(--ok); }
    .fab[data-s="fail"] .logo.sm { background: var(--err); }
    @keyframes pulse { 0%, 100% { opacity: 1 } 50% { opacity: .3 } }
  `;

  function panelHTML() {
    const rows = TASK_DEFS.map((t) =>
      `<div class="task" data-t="${t.key}" data-s="idle"><i class="dot"></i><span class="name">${t.label}</span><span class="st">待执行</span></div>`
    ).join('');
    return `
      <div class="fab" data-act="open" data-s="idle">
        <i class="logo sm"></i><span>每日任务</span><span class="badge">0/0</span>
      </div>
      <div class="panel">
        <div class="head">
          <i class="logo"></i>
          <span class="title">B站每日任务</span>
          <span class="ver">v${VERSION}</span>
          <button class="ico" data-act="cfg" title="设置">${ICON.cfg}</button>
          <button class="ico" data-act="min" title="收起">${ICON.min}</button>
          <button class="ico" data-act="hide" title="隐藏">${ICON.hide}</button>
        </div>
        <div class="exp" data-s="idle">
          <div class="exp-top">
            <span class="lv">LV--</span>
            <span class="exp-num">读取中</span>
            <button class="mini" data-act="exp" title="刷新经验值">${ICON.sync}</button>
          </div>
          <div class="bar"><i></i></div>
          <div class="exp-foot">
            <span class="hint">正在获取经验值</span>
            <span class="days"></span>
          </div>
        </div>
        <div class="tasks">${rows}</div>
        <div class="log"></div>
        <div class="actions">
          <button class="btn primary" data-act="run">开始执行</button>
          <button class="btn" data-act="stop">停止</button>
        </div>
        <div class="settings">
          <label class="row"><span>观看视频</span><input type="checkbox" data-cfg="enableWatch"></label>
          <label class="row"><span>分享视频</span><input type="checkbox" data-cfg="enableShare"></label>
          <label class="row"><span>投币</span><input type="checkbox" data-cfg="enableCoin"></label>
          <label class="row"><span>观看秒数</span><input type="number" min="10" max="600" step="10" data-cfg="watchSeconds"></label>
          <label class="row"><span>投币经验目标</span><input type="number" min="0" max="50" step="10" data-cfg="coinExpTarget"></label>
          <label class="row"><span>投币时点赞</span><input type="checkbox" data-cfg="selectLike"></label>
          <label class="row"><span>每天自动运行</span><input type="checkbox" data-cfg="autoRun"></label>
          <div class="tip">投币会消耗真实硬币（每日上限 5 枚）。观看任务在屏幕外播放，请保持本标签页在前台或允许后台播放。</div>
          <div class="credit">由 <b>Momomo</b> 制作 · 基于 MIT 许可证开源</div>
        </div>
      </div>
    `;
  }

  class Panel {
    constructor() {
      this.host = document.createElement('div');
      this.host.id = 'bdh-root';
      this.host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;';
      this.shadow = this.host.attachShadow({ mode: 'open' });
      this.shadow.innerHTML = `<style>${PANEL_CSS}</style>${panelHTML()}`;
      (document.body || document.documentElement).appendChild(this.host);

      this.el = this.shadow.querySelector('.panel');
      this.fab = this.shadow.querySelector('.fab');
      this.logBox = this.shadow.querySelector('.log');
      this.settings = this.shadow.querySelector('.settings');
      this.expBox = this.shadow.querySelector('.exp');
      this.runBtn = this.shadow.querySelector('[data-act="run"]');
      this.badge = this.fab.querySelector('.badge');
      this.rows = new Map();
      this.shadow.querySelectorAll('.task').forEach((r) => this.rows.set(r.dataset.t, r));
      this.collapsed = true;
      this.dragged = false;
      this.dragEndAt = 0;

      this.restorePos();
      this.bind();
      this.syncSettings();
      this.applyCollapsed();
      this.setButtons();
      this.updateFab();
      this.renderExp(expInfo, null);
    }

    restorePos() {
      const pos = store.get(KEY_POS, null);
      const ok = pos && Number.isFinite(pos.left) && Number.isFinite(pos.top) &&
        pos.left < window.innerWidth - 40 && pos.top < window.innerHeight - 40;
      if (ok) {
        this.host.style.left = Math.max(0, pos.left) + 'px';
        this.host.style.top = Math.max(0, pos.top) + 'px';
      } else {
        this.host.style.right = (cfg.panelRight || 16) + 'px';
        this.host.style.bottom = (cfg.panelBottom || 16) + 'px';
      }
    }

    bind() {
      this.shadow.addEventListener('click', (e) => {
        const act = e.target.closest && e.target.closest('[data-act]');
        if (!act) return;
        const a = act.dataset.act;
        if (a === 'run') runAll('手动');
        else if (a === 'stop') stopAll();
        else if (a === 'cfg') this.settings.classList.toggle('show');
        else if (a === 'open') { if (Date.now() - this.dragEndAt < 250) return; this.open(); }
        else if (a === 'min') this.collapse();
        else if (a === 'hide') this.hide();
        else if (a === 'exp') {
          const old = this.expBox.querySelector('.exp-num').textContent;
          this.expBox.querySelector('.exp-num').textContent = '刷新中';
          refreshExp(null, false).then(() => {
            if (this.expBox.querySelector('.exp-num').textContent === '刷新中') this.expBox.querySelector('.exp-num').textContent = old;
          });
        }
      });

      this.shadow.addEventListener('change', (e) => {
        const el = e.target.closest && e.target.closest('[data-cfg]');
        if (!el) return;
        const key = el.dataset.cfg;
        let val;
        if (el.type === 'checkbox') {
          val = el.checked;
        } else {
          val = Number(el.value);
          const min = Number(el.min || -Infinity);
          const max = Number(el.max || Infinity);
          if (!Number.isFinite(val)) val = DEFAULT_CONFIG[key];
          val = Math.max(min, Math.min(max, Math.round(val)));
          el.value = val;
        }
        cfg[key] = val;
        saveConfig();
        log(`设置已保存：${key} = ${val}`);
        this.updateFab();
      });

      this.bindDrag(this.shadow.querySelector('.head'));
      this.bindDrag(this.fab);
    }

    bindDrag(handle) {
      let dragging = false;
      let sx = 0, sy = 0, ox = 0, oy = 0, nx = 0, ny = 0, raf = 0;
      const apply = () => {
        raf = 0;
        this.host.style.left = nx + 'px';
        this.host.style.top = ny + 'px';
        this.host.style.right = 'auto';
        this.host.style.bottom = 'auto';
      };
      handle.addEventListener('pointerdown', (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        if (e.target.closest('button')) return;
        const box = (this.collapsed ? this.fab : this.el).getBoundingClientRect();
        dragging = true;
        this.dragged = false;
        sx = e.clientX; sy = e.clientY; ox = box.left; oy = box.top;
        try { handle.setPointerCapture(e.pointerId); } catch (err) {}
      });
      handle.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - sx, dy = e.clientY - sy;
        if (!this.dragged && Math.abs(dx) + Math.abs(dy) < 4) return;
        this.dragged = true;
        nx = Math.max(0, Math.min(window.innerWidth - 64, ox + dx));
        ny = Math.max(0, Math.min(window.innerHeight - 40, oy + dy));
        if (!raf) raf = requestAnimationFrame(apply);
      }, { passive: true });
      const end = (e) => {
        if (!dragging) return;
        dragging = false;
        if (raf) { cancelAnimationFrame(raf); apply(); }
        try { handle.releasePointerCapture(e.pointerId); } catch (err) {}
        if (this.dragged) {
          this.dragEndAt = Date.now();
          store.set(KEY_POS, { left: parseInt(this.host.style.left, 10) || 0, top: parseInt(this.host.style.top, 10) || 0 });
        }
      };
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    }

    applyCollapsed() {
      this.el.style.display = this.collapsed ? 'none' : '';
      this.fab.style.display = this.collapsed ? '' : 'none';
    }

    open() {
      this.collapsed = false;
      this.applyCollapsed();
      const age = expInfo && expInfo.at ? Date.now() - expInfo.at : Infinity;
      if (age > 300000) refreshExp(null, true);
    }

    collapse() {
      this.collapsed = true;
      this.updateFab();
      this.applyCollapsed();
    }

    updateFab() {
      let total = 1;
      if (cfg.enableWatch) total++;
      if (cfg.enableShare) total++;
      if (cfg.enableCoin) total++;
      const keys = ['login', 'watch', 'share', 'coin'].filter((k) =>
        k === 'login' ||
        (k === 'watch' && cfg.enableWatch) ||
        (k === 'share' && cfg.enableShare) ||
        (k === 'coin' && cfg.enableCoin)
      );
      const done = keys.filter((k) => (state.tasks[k] || {}).status === 'ok').length;
      const failed = keys.some((k) => (state.tasks[k] || {}).status === 'fail');
      this.badge.textContent = `${done}/${total}`;
      this.fab.dataset.s = state.running ? 'doing' : failed ? 'fail' : (done === total && done > 0) ? 'ok' : 'idle';
    }

    hide() {
      this.host.style.display = 'none';
    }

    show() {
      this.host.style.display = '';
      this.open();
    }

    get visible() {
      return this.host.style.display !== 'none';
    }

    syncSettings() {
      this.shadow.querySelectorAll('[data-cfg]').forEach((el) => {
        const key = el.dataset.cfg;
        if (el.type === 'checkbox') el.checked = !!cfg[key];
        else el.value = cfg[key];
      });
    }

    setButtons() {
      if (this.runBtn) this.runBtn.disabled = !!state.running;
    }

    appendLogs(lines) {
      const box = this.logBox;
      const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 8;
      const frag = document.createDocumentFragment();
      for (let i = 0; i < lines.length; i++) {
        const div = document.createElement('div');
        div.textContent = lines[i];
        frag.appendChild(div);
      }
      box.appendChild(frag);
      let extra = box.childNodes.length - 200;
      while (extra-- > 0) box.removeChild(box.firstChild);
      if (atBottom) box.scrollTop = box.scrollHeight;
    }

    renderExp(info, st) {
      const box = this.expBox;
      const lvEl = box.querySelector('.lv');
      const numEl = box.querySelector('.exp-num');
      const barEl = box.querySelector('.bar i');
      const hintEl = box.querySelector('.hint');
      const daysEl = box.querySelector('.days');
      if (!info) {
        box.dataset.s = 'idle';
        lvEl.textContent = 'LV--';
        numEl.textContent = '未获取';
        barEl.style.width = '0%';
        hintEl.textContent = '经验值读取失败';
        daysEl.textContent = '';
        box.title = '';
        return;
      }
      const sum = expSummary(info, st);
      lvEl.textContent = 'LV' + info.level;
      box.dataset.s = sum.max ? 'max' : 'idle';
      barEl.style.width = (sum.ratio * 100).toFixed(2) + '%';
      if (sum.max) {
        numEl.textContent = `${numFmt.format(info.exp)} 经验`;
        hintEl.textContent = '已达当前最高等级';
        daysEl.textContent = '满级';
      } else {
        numEl.textContent = `${numFmt.format(info.exp)} / ${numFmt.format(info.next)}`;
        hintEl.textContent = `距 LV${info.level + 1} 还差 ${numFmt.format(sum.remain)} 经验`;
        daysEl.textContent = `约 ${sum.days} 天`;
      }
      box.title = sum.max
        ? `当前 LV${info.level}，经验 ${numFmt.format(info.exp)}`
        : `当前 LV${info.level}：${numFmt.format(info.exp)} / ${numFmt.format(info.next)}\n还差 ${numFmt.format(sum.remain)} 经验，今日最多还能拿 ${sum.todayLeft}\n按每日满额 ${DAILY_MAX_EXP} 经验估算，约 ${sum.days} 天升到 LV${info.level + 1}`;
    }

    setTask(key, status, text) {
      state.tasks[key] = { status, text: text || '' };
      const row = this.rows.get(key);
      if (!row) return;
      row.dataset.s = status;
      const st = row.querySelector('.st');
      const label = (TASK_DEFS.find((t) => t.key === key) || {}).label || key;
      st.textContent = text || { idle: '待执行', doing: '执行中', ok: '完成', fail: '失败', skip: '已关闭' }[status] || '';
      st.title = `${label}：${st.textContent}`;
      this.updateFab();
    }
  }

  let panel = null;

  function setTask(key, status, text) {
    state.tasks[key] = { status, text: text || '' };
    if (panel) panel.setTask(key, status, text);
  }

  function resetTaskUI() {
    Object.keys(state.tasks).forEach((k) => { delete state.tasks[k]; });
    if (!panel) return;
    TASK_DEFS.forEach((t) => panel.setTask(t.key, 'idle', '待执行'));
  }

  function setRunningUI(running) {
    if (panel) { panel.setButtons(); panel.updateFab(); }
    if (running) log('执行中…（点「停止」可中断）');
  }

  function bootstrap() {
    try {
      const cached = store.get(KEY_EXP, null);
      if (cached && Number.isFinite(cached.exp)) expInfo = cached;
    } catch (e) {}

    try {
      panel = new Panel();
    } catch (e) {
      console.error('[B站每日任务] 面板创建失败', e);
      panel = null;
    }

    log(`已加载 v${VERSION}，右下角胶囊点一下展开。`);
    idle(() => {
      const dom = readRewardPanel(true);
      if (dom) {
        const part = Object.keys(dom).map((k) => {
          const it = dom[k];
          return it.exp !== null ? `${k} ${it.exp}/${it.target}` : `${k} ${it.done ? '✓' : '×'}`;
        });
        log('页面「每日奖励」读到：' + part.join('，'));
      }
    });

    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('▶ 立即执行每日任务', () => runAll('菜单'));
      GM_registerMenuCommand('⏹ 停止', stopAll);
      GM_registerMenuCommand('🔄 刷新经验值', () => refreshExp(null, false));
      GM_registerMenuCommand('👁 显示/隐藏面板', () => {
        if (!panel) return;
        if (panel.visible) panel.hide(); else panel.show();
      });
    }

    const stale = !expInfo || !expInfo.at || Date.now() - expInfo.at > 600000;
    if (stale) idle(() => { refreshExp(null, true); });

    if (cfg.autoRun && location.hostname === 'www.bilibili.com' && !state.running) {
      const s = loadDailyState();
      const maxRuns = Math.max(1, Number(cfg.maxRunsPerDay) || 2);
      if ((s.runs || 0) < maxRuns) {
        const delay = 6000 + Math.random() * 6000;
        log(`今日第 ${(s.runs || 0) + 1}/${maxRuns} 次自动执行将在 ${Math.round(delay / 1000)} 秒后开始`);
        setTimeout(() => { if (!state.running) runAll('每日自动'); }, delay);
      } else {
        log(`今日自动执行已达 ${s.runs} 次上限，可点「开始执行」手动再跑`);
      }
    }
  }

  if (document.body) bootstrap();
  else window.addEventListener('DOMContentLoaded', bootstrap, { once: true });
})();
