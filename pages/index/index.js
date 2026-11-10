// pages/index/index.js - 主列表页逻辑
// 行情（实时价、IOPV、涨跌）来自腾讯；申购状态来自 QDII Lens
const { NASDAQ_100_ETFS, SP500_ETFS, BENCHMARK,
  getChangeClass, formatAmount, getPremiumClass,
  calcTrackingError, calcPremium } = require('../../utils/etf-data');
const { fetchQuotes, fetchRankings, fetchNavHistory, fetchIndexKline, fetchPremiumTrend, isTradingHours } = require('../../utils/api');

const ETF_MAP = {};
for (const e of NASDAQ_100_ETFS.concat(SP500_ETFS)) {
  ETF_MAP[e.code] = e;
}

const REFRESH_INTERVAL = 5000;

Page({
  data: {
    activeTab: 'nasdaq',
    list: [],
    loading: true,
    refreshing: false,
    error: '',
    lastUpdate: '',
    isTrading: true,

    // 顶部指数溢价中位数迷你趋势
    premiumTrend: {
      label: '纳指100',
      anchor: 'center',
      current: null,
      currentStr: '--',
      cls: '',
      bars: [],
      lastIndex: -1,
      minStr: '--',
      maxStr: '--'
    }
  },

  _nasdaqData: [],
  _sp500Data: [],
  _refreshTimer: null,
  _subStatusCache: {},     // code → subStatus/subLabel
  _teCache: {},            // code → 跟踪误差文本（按日缓存）
  _teDone: false,          // 本日是否已算过跟踪误差
  _subLoaded: false,       // 申购状态是否已加载
  _trendCache: {},         // 'nasdaq' / 'sp500' → points
  _trendLoading: {},       // 正在加载标记
  _order: null,            // 首次定序结果：tabKey → [code]

  onLoad() {
    // 读取当日跟踪误差缓存（内联实现，避免依赖热更新可能缺失的方法）
    try {
      const d = new Date();
      const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const cached = wx.getStorageSync('te_cache');
      if (cached && cached.date === today && cached.map) {
        this._teCache = cached.map;
        this._teDone = true;
      }
    } catch (e) {
      console.warn('跟踪误差缓存读取失败:', e);
    }
    if (!this._teCache) this._teCache = {};

    this.fetchData();
    this.loadTrend();
  },

  onShow() {
    this.startAutoRefresh();
  },

  onHide() {
    this.stopAutoRefresh();
  },

  onUnload() {
    this.stopAutoRefresh();
  },

  // ========== 数据获取 ==========

  async fetchData() {
    this.setData({ loading: true, error: '' });

    try {
      // 腾讯行情（实时，溢价跟着盘中价变）
      const allEtfs = NASDAQ_100_ETFS.concat(SP500_ETFS);
      const txRes = await fetchQuotes(allEtfs);

      this._nasdaqData = this.mapQuoteData('nasdaq', NASDAQ_100_ETFS, txRes.items);
      this._sp500Data  = this.mapQuoteData('sp500', SP500_ETFS, txRes.items);
      this.updateListData();

      this.setData({
        isTrading: isTradingHours(),
        lastUpdate: this.formatTime(new Date()),
        loading: false,
        refreshing: false
      });

      // 后台补：申购状态（每会话一次） + 跟踪误差（每交易日一次）
      if (!this._subLoaded) this.loadSubStatus();
      if (!this._teDone) this.loadTrackingErrors();
    } catch (err) {
      console.error('获取行情失败:', err);
      this.setData({
        loading: false,
        refreshing: false,
        error: this.buildErrorMessage(err)
      });
    }
  },

  /**
   * 将腾讯行情映射为卡片格式
   * 溢价实时计算：(最新价 ÷ 净值 − 1) × 100
   */
  mapQuoteData(tabKey, etfPool, items) {
    const list = etfPool.map(etf => {
      const meta = ETF_MAP[etf.code] || {};
      const q = items.find(i => i.code === etf.code) || {};

      const price      = q.price;
      const iopv       = q.iopv;                       // 盘中实时估算净值
      const changePct  = q.changePct;                  // 腾讯已 ×100
      const premium    = calcPremium(price, iopv);     // 与同花顺/华泰同口径：price/iopv-1

      const formatPct = (v) => {
        if (v == null) return '--';
        const sign = v >= 0 ? '+' : '';
        return `${sign}${v.toFixed(2)}%`;
      };

      const cachedSub = (this._subStatusCache && this._subStatusCache[etf.code]) || {};

      return {
        code:          meta.code,
        market:        meta.market,
        name:          meta.fullName || meta.name,
        company:       meta.company,
        fullName:      meta.fullName,
        price:         price,
        nav:           iopv,
        change:        changePct,
        premium:       premium,
        open:          q.open,
        high:          q.high,
        low:           q.low,
        prevClose:     q.prevClose,
        amount:        q.amountWan,
        priceStr:      price != null ? price.toFixed(3) : '--',
        changeStr:     formatPct(changePct),
        changeClass:   getChangeClass(changePct),
        premiumStr:    formatPct(premium),
        premiumClass:  getPremiumClass(premium),
        iopvStr:       iopv != null ? iopv.toFixed(3) : '--',
        prevCloseStr:  q.prevClose != null ? q.prevClose.toFixed(3) : '--',
        amountStr:     formatAmount(q.amountWan),
        trackingErrStr: (this._teCache && this._teCache[etf.code]) || '--',
        subStatus:     cachedSub.status || null,
        subLabel:      cachedSub.label || '',
        quoteTime:     q.time || ''
      };
    });

    // 首次加载按溢价率由低到高定序，后续刷新只更新数值、保持顺序
    return this.applyPremiumOrder(tabKey, list);
  },

  /**
   * 首次按溢价率升序排列并记住顺序；之后沿用该顺序
   * 新出现的基金代码追加到末尾
   */
  applyPremiumOrder(tabKey, list) {
    if (!this._order) this._order = {};
    const saved = this._order[tabKey];

    if (!saved) {
      list.sort((a, b) => {
        const pa = (a.premium == null) ? Infinity : a.premium;
        const pb = (b.premium == null) ? Infinity : b.premium;
        return pa - pb;
      });
      this._order[tabKey] = list.map(i => i.code);
      return list;
    }

    const pos = {};
    saved.forEach((code, i) => { pos[code] = i; });

    list.sort((a, b) => {
      const ia = pos[a.code];
      const ib = pos[b.code];
      if (ia === undefined && ib === undefined) return 0;
      if (ia === undefined) return 1;
      if (ib === undefined) return -1;
      return ia - ib;
    });

    // 记录新出现的代码，避免下次仍排到末尾
    const append = list.filter(i => pos[i.code] === undefined).map(i => i.code);
    if (append.length) this._order[tabKey] = saved.concat(append);

    return list;
  },

  // ========== 申购状态（QDII Lens）==========

  async loadSubStatus() {
    this._subLoaded = true;
    if (!this._subStatusCache) this._subStatusCache = {};
    try {
      const [nasdaqRes, sp500Res] = await Promise.all([
        fetchRankings('nasdaq-100'),
        fetchRankings('sp-500')
      ]);
      for (const item of (nasdaqRes.items || []).concat(sp500Res.items || [])) {
        const rules = item.rules || [];
        const subs = rules.find(r => (r.action || '').includes('create'));
        if (subs && item.code) {
          const labels = { suspended: '暂停申购', limited: '限大额', open: '开放' };
          this._subStatusCache[item.code] = {
            status: subs.status,
            label: labels[subs.status] || ''
          };
          this.updateSubBadge(item.code, subs.status, labels[subs.status] || '');
        }
      }
    } catch (e) {
      console.warn('申购状态加载失败:', e);
    }
  },

  updateSubBadge(code, status, label) {
    const key = this.data.activeTab === 'nasdaq' ? '_nasdaqData' : '_sp500Data';
    const arr = this[key];
    if (!arr) return;
    const idx = arr.findIndex(item => item.code === code);
    if (idx < 0) return;
    arr[idx].subStatus = status;
    arr[idx].subLabel = label;
    this.setData({
      [`list[${idx}].subStatus`]: status,
      [`list[${idx}].subLabel`]: label
    });
  },

  // ========== Tab 切换 ==========

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (tab === this.data.activeTab) return;
    this.setData({ activeTab: tab });
    this.updateListData();
    this.applyTrend();
  },

  updateListData() {
    const data = this.data.activeTab === 'nasdaq'
      ? this._nasdaqData
      : this._sp500Data;
    this.setData({ list: data });
  },

  // ========== 顶部指数溢价中位数迷你趋势 ==========

  /**
   * 预取两个指数的溢价中位数趋势（各 90 天）
   */
  loadTrend() {
    this.fetchTrendFor('nasdaq');
    this.fetchTrendFor('sp500');
  },

  fetchTrendFor(tabKey) {
    if (this._trendCache[tabKey] || this._trendLoading[tabKey]) return Promise.resolve();
    this._trendLoading[tabKey] = true;
    if (!this._trendCache) this._trendCache = {};

    const slug = tabKey === 'sp500' ? 'sp-500' : 'nasdaq-100';
    return fetchPremiumTrend(slug, 90)
      .then(res => {
        this._trendCache[tabKey] = res.points || [];
        if (this.data.activeTab === tabKey) this.applyTrend();
      })
      .catch(e => {
        console.warn(`[溢价趋势] ${tabKey} 加载失败:`, e.message || e);
      })
      .then(() => {
        this._trendLoading[tabKey] = false;
      });
  },

  /**
   * 把缓存中的趋势数据转成迷你柱状条，写入 data.premiumTrend
   */
  applyTrend() {
    const tabKey = this.data.activeTab;
    const points = (this._trendCache && this._trendCache[tabKey]) || [];
    const label = tabKey === 'sp500' ? '标普500' : '纳指100';

    if (!points.length) {
      this.fetchTrendFor(tabKey);
      this.setData({
        premiumTrend: {
          label, current: null, currentStr: '--', cls: '',
          bars: [], lastIndex: -1, minStr: '--', maxStr: '--'
        }
      });
      return;
    }

    // 只取最近 60 个交易日，保证条不拥挤
    const recent = points.slice(-60);
    const vals = recent.map(p => p.median);
    const hasNeg = vals.some(v => v < 0);

    const maxAbs = Math.max(1, ...recent.map(p => Math.abs(p.median)));
    // 全为正时从底部起算更饱满；正负混合则以 0 为中线
    const scale = hasNeg ? 46 : 92;

    const bars = recent.map((p, i) => {
      const v = p.median;
      const isUp = v >= 0;
      const h = Math.max(3, (Math.abs(v) / maxAbs) * scale + 2);
      return {
        i,
        up: isUp ? h : 0,
        down: isUp ? 0 : h
      };
    });

    const last = recent[recent.length - 1];

    this.setData({
      premiumTrend: {
        label,
        anchor: hasNeg ? 'center' : 'bottom',
        current: last.median,
        currentStr: (last.median >= 0 ? '+' : '') + last.median.toFixed(2) + '%',
        cls: last.median >= 0 ? 'up' : 'down',
        bars,
        lastIndex: bars.length - 1,
        minStr: Math.min(...vals).toFixed(1) + '%',
        maxStr: Math.max(...vals).toFixed(1) + '%'
      }
    });
  },

  // ========== 跳转详情 ==========

  goDetail(e) {
    const { code, market, name, company, fullname } = e.currentTarget.dataset;
    wx.navigateTo({
      url: `/pages/detail/detail?code=${code}&market=${market}&name=${encodeURIComponent(name)}&company=${encodeURIComponent(company || '')}&fullName=${encodeURIComponent(fullname || '')}`
    });
  },

  // ========== 下拉刷新 ==========

  onRefresh() {
    this.setData({ refreshing: true });
    this.fetchData();
  },

  // ========== 自动刷新 ==========

  startAutoRefresh() {
    this.stopAutoRefresh();
    this._refreshTimer = setInterval(() => {
      if (isTradingHours()) {
        this.fetchData();
      }
    }, REFRESH_INTERVAL);
  },

  stopAutoRefresh() {
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = null;
    }
  },

  // ========== 跟踪误差（每交易日算一次，结果本地缓存） ==========

  async loadTrackingErrors() {
    this._teDone = true;
    this.loadGroupTrackingError(NASDAQ_100_ETFS, '_nasdaqData', BENCHMARK.nasdaq);
    this.loadGroupTrackingError(SP500_ETFS, '_sp500Data', BENCHMARK.sp500);
  },

  async loadGroupTrackingError(etfList, dataKey, indexSymbol) {
    let idxKlines = null;
    try {
      const idxRes = await fetchIndexKline(indexSymbol);
      idxKlines = idxRes.klines;
      console.log(`[跟踪误差] 指数 ${indexSymbol} 加载成功, ${idxKlines.length} 条`);
    } catch (e) {
      console.error(`[跟踪误差] 指数 ${indexSymbol} 加载失败:`, e.message || e);
      return;
    }

    for (const etf of etfList) {
      try {
        const navRes = await fetchNavHistory(etf.code);
        const te = calcTrackingError(navRes.navList, idxKlines);
        const str = te !== null ? (te * 100).toFixed(2) + '%' : '数据不足';
        this.updateTrackingError(dataKey, etf.code, str);
        console.log(`[跟踪误差] ${etf.code} = ${str}`);
      } catch (e) {
        console.error(`[跟踪误差] ${etf.code} 失败:`, e.message || e);
      }
    }
  },

  updateTrackingError(dataKey, code, value) {
    const arr = this[dataKey];
    if (!arr) return;
    const idx = arr.findIndex(item => item.code === code);
    if (idx >= 0) arr[idx].trackingErrStr = value;

    // 写入本地缓存（按日）
    if (!this._teCache) this._teCache = {};
    this._teCache[code] = value;
    if (typeof this.saveTeCache === 'function') this.saveTeCache();

    const tabDataKey = this.data.activeTab === 'nasdaq' ? '_nasdaqData' : '_sp500Data';
    if (dataKey === tabDataKey && idx >= 0) {
      this.setData({
        [`list[${idx}].trackingErrStr`]: value
      });
    }
  },

  // ========== 跟踪误差本地缓存 ==========

  todayStr() {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  },

  restoreTeCache() {
    try {
      const cached = wx.getStorageSync('te_cache');
      if (cached && cached.date === this.todayStr() && cached.map) {
        this._teCache = cached.map;
        this._teDone = true;
      }
    } catch (e) {
      console.warn('跟踪误差缓存读取失败:', e);
    }
  },

  saveTeCache() {
    try {
      wx.setStorageSync('te_cache', { date: this.todayStr(), map: this._teCache });
    } catch (e) {
      // 存储失败不影响功能
    }
  },

  // ========== 格式化辅助 ==========

  formatTime(date) {
    const h = String(date.getHours()).padStart(2, '0');
    const m = String(date.getMinutes()).padStart(2, '0');
    const s = String(date.getSeconds()).padStart(2, '0');
    return `${h}:${m}:${s}`;
  },

  buildErrorMessage(err) {
    const msg = (err && err.message) || '未知错误';
    if (msg.indexOf('HTTP') >= 0 || msg.indexOf('请求失败') >= 0) {
      return '网络请求失败，请检查：\n1. 开发者工具「设置 → 项目设置 → 本地设置」是否勾选「不校验合法域名」\n2. 手机网络是否正常\n3. 稍后重试';
    }
    return msg;
  }
});