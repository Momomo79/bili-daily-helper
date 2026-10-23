// ==UserScript==
// @name         B站每日任务助手 · 自动完成每日奖励
// @namespace    https://local/bili-daily-helper
// @version      1.3.0
// @description  自动完成哔哩哔哩网页版每日任务：观看视频、分享视频、投币，带面板与每日自动运行。
// @author       Momomo
// @match        https://www.bilibili.com/*
// @match        https://space.bilibili.com/*
// @match        https://t.bilibili.com/*
// @match        https://account.bilibili.com/*
// @match        https://message.bilibili.com/*
// @icon         https://s1.hdslb.com/bfs/static/jinkela/long/images/512.png
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

  const VERSION = '1.3.0';
  const NS = 'bili-daily-helper';
  const KEY_CFG = NS + ':cfg';
  const KEY_STATE = NS + ':state';
  const KEY_POS = NS + ':pos';

  const DEFAULT_CONFIG = {
    enableWatch: true,      // 观看视频（后台小窗静音播放，完成「每日观看」经验）
    enableShare: true,      // 分享视频（每日分享 +5 经验）
    enableCoin: true,       // 投币（每日投币 +经验，注意：消耗真实硬币）
    watchSeconds: 60,       // 观看时长（秒），60 秒足够触发每日观看
    coinExpTarget: 50,      // 每日投币想拿到多少经验（每枚 +10，即面板上的「已获得X/50」）；10 = 只做基础任务
    selectLike: false,      // 投币时是否顺手点赞
    autoRun: true,          // 打开 www.bilibili.com 时自动跑一次
    maxRunsPerDay: 2,       // 每天最多自动尝试次数（有任务失败时留一次重试）
    panelRight: 16,         // 面板初始位置（距右/下，px）
    panelBottom: 16
  };

  const API = {
    nav:        'https://api.bilibili.com/x/web-interface/nav',
    reward:     'https://api.bilibili.com/x/member/web/exp/reward',
    share:      'https://api.bilibili.com/x/web-interface/share/add',
    coinAdd:    'https://api.bilibili.com/x/web-interface/coin/add',
    coinState:  'https://api.bilibili.com/x/web-interface/archive/coins',
    ranking:    'https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all',
    popular:    'https://api.bilibili.com/x/web-interface/popular',
    toview:     'https://api.bilibili.com/x/v2/history/toview'
  };

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

  function log(msg) {
    const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`;
    try { console.log('[B站每日任务]', msg); } catch (e) {}
    if (panel) panel.appendLog(line);
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      const sig = state.signal;
      if (sig && typeof sig.addEventListener === 'function') {
        sig.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
      }
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

  function short(t, n = 18) {
    const s = String(t || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n) + '…' : (s || '(无标题)');
  }

  function shuffle(arr) {
    const a = arr.slice();
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
    const payload = isPost ? toForm(params) : null;
    const fullUrl = (!isPost && params) ? url + (url.indexOf('?') >= 0 ? '&' : '?') + toForm(params) : url;

    const viaFetch = () => fetch(fullUrl, {
      method: isPost ? 'POST' : 'GET',
      credentials: 'include',
      headers: isPost ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {},
      body: isPost ? payload : undefined
    }).then((r) => r.text()).then((txt) => {
      try { return JSON.parse(txt); } catch (e) { throw new Error('接口返回不是 JSON'); }
    });

    return viaFetch().catch((err) => {
      if (typeof GM_xmlhttpRequest !== 'function') throw err;
      return new Promise((resolve, reject) => {
        const headers = { 'Referer': 'https://www.bilibili.com/' };
        if (isPost) headers['Content-Type'] = 'application/x-www-form-urlencoded';
        GM_xmlhttpRequest({
          method: isPost ? 'POST' : 'GET',
          url: fullUrl,
          data: payload || undefined,
          timeout: 20000,
          headers,
          onload: (res) => {
            try { resolve(JSON.parse(res.responseText)); } catch (e) { reject(new Error('接口返回不是 JSON')); }
          },
          onerror: () => reject(new Error('网络错误')),
          ontimeout: () => reject(new Error('请求超时'))
        });
      });
    });
  }

  async function checkLogin() {
    const r = await request('GET', API.nav);
    return !!(r && r.code === 0 && r.data && r.data.isLogin);
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

  function readRewardPanel() {
    const labels = ['每日登录', '每日观看视频', '每日投币', '每日分享视频'];
    const res = {};
    let nodes;
    try { nodes = document.querySelectorAll('div,li,dd,span,p'); } catch (e) { return null; }
    for (const el of nodes) {
      let txt = '';
      try { txt = (el.textContent || '').replace(/\s+/g, ''); } catch (e) { continue; }
      if (!txt || txt.length > 30) continue;
      const hit = labels.find((l) => txt.indexOf(l) === 0);
      if (!hit || res[hit]) continue;
      let box = el.parentElement;
      let info = '';
      for (let i = 0; i < 4 && box; i++) {
        const bt = (box.textContent || '').replace(/\s+/g, '');
        if (labels.filter((l) => bt.indexOf(l) >= 0).length > 1) break;
        if (/已获得\d+\/\d+|经验值到手|已完成/.test(bt)) { info = bt; break; }
        box = box.parentElement;
      }
      if (!info) continue;
      const m = info.match(/已获得(\d+)\/(\d+)/);
      if (m) {
        res[hit] = { done: Number(m[1]) >= Number(m[2]), exp: Number(m[1]), target: Number(m[2]) };
      } else {
        res[hit] = { done: /经验值到手|已完成/.test(info), exp: null, target: null };
      }
    }
    return Object.keys(res).length ? res : null;
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

  async function doShare(v) {
    const csrf = getCsrf();
    if (!csrf) throw new Error('拿不到 bili_jct（bili_jct），请确认已登录');
    return request('POST', API.share, { aid: v.aid, bvid: v.bvid, csrf });
  }

  async function doCoin(v, multiply) {
    const csrf = getCsrf();
    if (!csrf) throw new Error('拿不到 bili_jct（bili_jct），请确认已登录');
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
    const push = (aid, bvid, title, owner) => {
      const id = Number(aid);
      if (!id || out.some((v) => v.aid === id)) return;
      out.push({ aid: id, bvid: bvid || av2bv(id), title: title || '', owner: owner || '' });
    };
    try {
      const r = await request('GET', API.ranking);
      if (r && r.code === 0) (r.data.list || []).forEach((v) => push(v.aid, v.bvid, v.title, v.owner && v.owner.name));
    } catch (e) {}
    try {
      const r = await request('GET', API.popular, { ps: 30, pn: 1 });
      if (r && r.code === 0) (r.data.list || []).forEach((v) => push(v.aid, v.bvid, v.title, v.owner && v.owner.name));
    } catch (e) {}
    try {
      const r = await request('GET', API.toview);
      if (r && r.code === 0) (r.data.list || []).forEach((v) => push(v.aid, v.bvid, v.title, v.owner && v.owner.name));
    } catch (e) {}
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
      throw new Error('观看任务需要在 www.bilibili.com 页面执行（跨子域 iframe 会被 X-Frame-Options 拦下）');
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

    const cleanup = () => { try { frame.remove(); } catch (e) {} };

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
          log('⚠️ 播放进度没动：请切回本标签页，或在浏览器设置里允许后台标签页播放');
          try { await video.play(); } catch (e) {}
        }
      }
      try { video.pause(); } catch (e) {}
      log(`✅ 播放完成：${short(v.title)}`);
      return v;
    } finally {
      cleanup();
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
      let loggedIn = false;
      try { loggedIn = await checkLogin(); } catch (e) { log('⚠️ 登录状态查询失败：' + e.message); }
      if (!loggedIn) {
        setTask('login', 'fail', '未登录');
        log('❌ 当前未登录，请先登录 B 站账号再执行');
        return;
      }
      state.counted = true;
      setTask('login', 'ok', '已登录');

      let st = null;
      try { st = await readTasks(); } catch (e) { log('⚠️ 任务状态读取失败：' + e.message); }
      if (st) {
        const p0 = coinProgress(st);
        log(`当前状态：登录${st.login ? '√' : '×'} 观看${st.watch ? '√' : '×'} 分享${st.share ? '√' : '×'} 投币 ${p0.exp}/${p0.target} 经验`);
        setTask('watch', st.watch ? 'ok' : 'idle', st.watch ? '今日已完成' : '待执行');
        setTask('share', st.share ? 'ok' : 'idle', st.share ? '今日已完成' : '待执行');
        setTask('coin', st.coins > 0 ? 'ok' : 'idle', `投币经验 ${p0.exp}/${p0.target}`);
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
          log(`执行后状态：登录${st2.login ? '√' : '×'} 观看${st2.watch ? '√' : '×'} 分享${st2.share ? '√' : '×'} 投币 ${coinProgress(st2).exp}/${cfg.coinExpTarget} 经验`);
          setTask('login', st2.login ? 'ok' : 'fail', st2.login ? '已登录' : '未登录');
          if (cfg.enableWatch) setTask('watch', st2.watch ? 'ok' : 'fail', st2.watch ? '今日已完成' : '未完成');
          if (cfg.enableShare) setTask('share', st2.share ? 'ok' : 'fail', st2.share ? '今日已完成' : '未完成');
          if (cfg.enableCoin) { const p2 = coinProgress(st2); setTask('coin', p2.need <= 0 ? 'ok' : 'fail', `投币经验 ${p2.exp}/${p2.target}`); }
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
    const failed = Object.keys(state.tasks).filter((k) => state.tasks[k] && state.tasks[k].status === 'fail');
    const ok = Object.keys(state.tasks).filter((k) => state.tasks[k] && state.tasks[k].status === 'ok');
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
    { key: 'login',    label: '登录状态' },
    { key: 'watch',    label: '观看视频' },
    { key: 'share',    label: '分享视频' },
    { key: 'coin',     label: '投币' }
  ];

  const PANEL_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
    .panel {
      width: 288px; background: #1f2026; color: #e6e6e8; border-radius: 12px;
      box-shadow: 0 8px 28px rgba(0,0,0,.45); border: 1px solid rgba(251,114,153,.28);
      overflow: hidden; font-size: 12px; line-height: 1.5; user-select: none;
    }
    .head {
      display: flex; align-items: center; gap: 6px; padding: 9px 10px;
      background: linear-gradient(135deg, #fb7299, #b23a5e); cursor: move;
    }
    .title { font-size: 13px; font-weight: 600; color: #fff; flex: 1; }
    .ver { font-size: 10px; color: rgba(255,255,255,.7); }
    .ico {
      width: 20px; height: 20px; border-radius: 5px; border: 0; cursor: pointer;
      background: rgba(255,255,255,.18); color: #fff; font-size: 12px; line-height: 1; padding: 0;
    }
    .ico:hover { background: rgba(255,255,255,.34); }
    .body { padding: 8px 10px 10px; }
    .body.hide { display: none; }
    .tasks { display: grid; gap: 2px; margin-bottom: 8px; }
    .task { display: flex; align-items: center; gap: 7px; padding: 3px 2px; }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: #5a5c66; flex: 0 0 auto; }
    .task .name { flex: 1; color: #c9cad1; }
    .task .st { color: #85879a; font-size: 11px; max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .task[data-s="doing"] .dot { background: #ffb02e; animation: pulse 1s infinite; }
    .task[data-s="doing"] .st { color: #ffb02e; }
    .task[data-s="ok"] .dot { background: #46c46a; }
    .task[data-s="ok"] .st { color: #46c46a; }
    .task[data-s="fail"] .dot { background: #ff5c5c; }
    .task[data-s="fail"] .st { color: #ff5c5c; }
    .task[data-s="skip"] .st { color: #6b6d7a; }
    @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
    .log {
      height: 96px; overflow-y: auto; background: #17181d; border-radius: 7px;
      padding: 6px 7px; font-size: 11px; color: #9a9cab; white-space: pre-wrap;
      word-break: break-all; user-select: text; font-family: Consolas, Menlo, monospace;
    }
    .log::-webkit-scrollbar { width: 5px; }
    .log::-webkit-scrollbar-thumb { background: #3a3c46; border-radius: 3px; }
    .actions { display: flex; gap: 6px; margin-top: 8px; }
    .btn {
      flex: 1; border: 1px solid #3a3c46; background: #26282f; color: #d6d7dd;
      border-radius: 7px; padding: 6px 0; font-size: 12px; cursor: pointer;
    }
    .btn:hover { background: #303239; }
    .btn.primary { background: #fb7299; border-color: #fb7299; color: #fff; font-weight: 600; }
    .btn.primary:hover { background: #ff86a9; }
    .btn:disabled { opacity: .45; cursor: not-allowed; }
    .settings { display: none; margin-top: 8px; padding-top: 8px; border-top: 1px dashed #3a3c46; }
    .settings.show { display: block; }
    .row { display: flex; align-items: center; justify-content: space-between; padding: 3px 0; color: #c2c3cb; }
    .row input[type=checkbox] { accent-color: #fb7299; width: 14px; height: 14px; cursor: pointer; }
    .row input[type=number] {
      width: 56px; background: #26282f; color: #e6e6e8; border: 1px solid #3a3c46;
      border-radius: 5px; padding: 2px 5px; font-size: 11px; text-align: center;
    }
    .tip { margin-top: 6px; font-size: 10px; color: #7b7d8c; line-height: 1.45; }
  `;

  function panelHTML() {
    const rows = TASK_DEFS.map((t) =>
      `<div class="task" data-t="${t.key}" data-s="idle"><i class="dot"></i><span class="name">${t.label}</span><span class="st">待执行</span></div>`
    ).join('');
    return `
      <div class="panel">
        <div class="head">
          <span class="title">B站每日任务</span>
          <span class="ver">v${VERSION}</span>
          <button class="ico" data-act="min" title="最小化">—</button>
          <button class="ico" data-act="hide" title="隐藏（可从油猴菜单重新打开）">×</button>
        </div>
        <div class="body">
          <div class="tasks">${rows}</div>
          <div class="log"></div>
          <div class="actions">
            <button class="btn primary" data-act="run">立即执行</button>
            <button class="btn" data-act="stop">停止</button>
            <button class="btn" data-act="cfg">设置</button>
          </div>
          <div class="settings">
            <label class="row"><span>观看视频</span><input type="checkbox" data-cfg="enableWatch"></label>
            <label class="row"><span>分享视频</span><input type="checkbox" data-cfg="enableShare"></label>
            <label class="row"><span>投币</span><input type="checkbox" data-cfg="enableCoin"></label>
            <label class="row"><span>观看秒数</span><input type="number" min="10" max="600" step="10" data-cfg="watchSeconds"></label>
            <label class="row"><span>投币经验目标</span><input type="number" min="0" max="50" step="10" data-cfg="coinExpTarget"></label>
            <label class="row"><span>投币时点赞</span><input type="checkbox" data-cfg="selectLike"></label>
            <label class="row"><span>每天自动运行</span><input type="checkbox" data-cfg="autoRun"></label>
            <div class="tip">投币会消耗真实硬币（每天上限 5 枚）。观看任务在屏幕外播放，请保持本标签页在前台或允许后台播放。</div>
          </div>
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
      this.body = this.shadow.querySelector('.body');
      this.logBox = this.shadow.querySelector('.log');
      this.settings = this.shadow.querySelector('.settings');
      this.runBtn = this.shadow.querySelector('[data-act="run"]');
      this.minimized = false;

      this.restorePos();
      this.bind();
      this.syncSettings();
      this.setButtons();
    }

    restorePos() {
      const pos = store.get(KEY_POS, null);
      if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
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
        else if (a === 'min') this.toggleMin();
        else if (a === 'hide') this.hide();
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
      });

      const head = this.shadow.querySelector('.head');
      let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
      head.addEventListener('pointerdown', (e) => {
        if (e.target.closest('[data-act]')) return;
        const r = this.el.getBoundingClientRect();
        dragging = true;
        sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
        this.host.style.left = r.left + 'px';
        this.host.style.top = r.top + 'px';
        this.host.style.right = 'auto';
        this.host.style.bottom = 'auto';
        head.setPointerCapture(e.pointerId);
      });
      head.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const left = Math.max(0, Math.min(window.innerWidth - 60, ox + e.clientX - sx));
        const top = Math.max(0, Math.min(window.innerHeight - 30, oy + e.clientY - sy));
        this.host.style.left = left + 'px';
        this.host.style.top = top + 'px';
      });
      head.addEventListener('pointerup', (e) => {
        if (!dragging) return;
        dragging = false;
        try { head.releasePointerCapture(e.pointerId); } catch (err) {}
        store.set(KEY_POS, { left: parseInt(this.host.style.left, 10) || 0, top: parseInt(this.host.style.top, 10) || 0 });
      });
    }

    toggleMin() {
      this.minimized = !this.minimized;
      this.body.classList.toggle('hide', this.minimized);
    }

    hide() {
      this.host.style.display = 'none';
    }

    show() {
      this.host.style.display = '';
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

    appendLog(line) {
      const atBottom = this.logBox.scrollTop + this.logBox.clientHeight >= this.logBox.scrollHeight - 4;
      const div = document.createElement('div');
      div.textContent = line;
      this.logBox.appendChild(div);
      while (this.logBox.childNodes.length > 200) this.logBox.removeChild(this.logBox.firstChild);
      if (atBottom) this.logBox.scrollTop = this.logBox.scrollHeight;
    }

    setTask(key, status, text) {
      state.tasks[key] = { status, text: text || '' };
      const row = this.shadow.querySelector(`.task[data-t="${key}"]`);
      if (!row) return;
      row.dataset.s = status;
      const st = row.querySelector('.st');
      const label = (TASK_DEFS.find((t) => t.key === key) || {}).label || key;
      st.textContent = text || { idle: '待执行', doing: '执行中', ok: '完成', fail: '失败', skip: '已关闭' }[status] || '';
      st.title = `${label}：${st.textContent}`;
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
    if (panel) panel.setButtons();
    if (running) log('执行中…（点「停止」可中断）');
  }

  function bootstrap() {
    try {
      panel = new Panel();
    } catch (e) {
      console.error('[B站每日任务] 面板创建失败', e);
      panel = null;
    }

    log(`已加载 v${VERSION}，右下角面板可拖动。建议在 www.bilibili.com 使用。`);
    const dom = readRewardPanel();
    if (dom) {
      const part = Object.keys(dom).map((k) => {
        const it = dom[k];
        return it.exp !== null ? `${k} ${it.exp}/${it.target}` : `${k} ${it.done ? '✓' : '×'}`;
      });
      log('页面「每日奖励」读到：' + part.join('，'));
    }

    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('▶ 立即执行每日任务', () => runAll('菜单'));
      GM_registerMenuCommand('⏹ 停止', stopAll);
      GM_registerMenuCommand('👁 显示/隐藏面板', () => {
        if (!panel) return;
        if (panel.visible) panel.hide(); else panel.show();
      });
    }

    if (cfg.autoRun && location.hostname === 'www.bilibili.com' && !state.running) {
      const s = loadDailyState();
      const maxRuns = Math.max(1, Number(cfg.maxRunsPerDay) || 2);
      if ((s.runs || 0) < maxRuns) {
        const delay = 6000 + Math.random() * 6000;
        log(`今日第 ${(s.runs || 0) + 1}/${maxRuns} 次自动执行将在 ${Math.round(delay / 1000)} 秒后开始`);
        setTimeout(() => { if (!state.running) runAll('每日自动'); }, delay);
      } else {
        log(`今日自动执行已达 ${s.runs} 次上限，可点「立即执行」手动再跑`);
      }
    }
  }

  if (document.body) bootstrap();
  else window.addEventListener('DOMContentLoaded', bootstrap, { once: true });
})();
