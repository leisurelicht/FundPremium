// pages/index/index.js - 主列表页逻辑
// 行情（实时价、IOPV、涨跌）来自腾讯；申购状态来自 QDII Lens
const { NASDAQ_100_ETFS, SP500_ETFS, BENCHMARK,
  getChangeClass, formatAmount, getPremiumClass,
  calcTrackingError, calcPremium } = require('../../utils/etf-data');
const { fetchQuotes, fetchRankings, fetchNavHistory, fetchIndexKline, isTradingHours } = require('../../utils/api');

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
    isTrading: true
  },

  _nasdaqData: [],
  _sp500Data: [],
  _refreshTimer: null,
  _subStatusCache: {},     // code → subStatus/subLabel

  onLoad() {
    this.fetchData();
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

      this._nasdaqData = this.mapQuoteData(NASDAQ_100_ETFS, txRes.items);
      this._sp500Data  = this.mapQuoteData(SP500_ETFS, txRes.items);
      this.updateListData();

      this.setData({
        isTrading: isTradingHours(),
        lastUpdate: this.formatTime(new Date()),
        loading: false,
        refreshing: false
      });

      // 后台补：申购状态 + 跟踪误差
      this.loadSubStatus();
      this.loadTrackingErrors();
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
  mapQuoteData(etfPool, items) {
    return etfPool.map(etf => {
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

      const cachedSub = this._subStatusCache[etf.code] || {};

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
        trackingErrStr: '--',
        subStatus:     cachedSub.status || null,
        subLabel:      cachedSub.label || '',
        quoteTime:     q.time || ''
      };
    });
  },

  // ========== 申购状态（QDII Lens）==========

  async loadSubStatus() {
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
  },

  updateListData() {
    const data = this.data.activeTab === 'nasdaq'
      ? this._nasdaqData
      : this._sp500Data;
    this.setData({ list: data });
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

  // ========== 跟踪误差（后台渐进加载） ==========

  async loadTrackingErrors() {
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
    if (idx < 0) return;
    arr[idx].trackingErrStr = value;

    const tabDataKey = this.data.activeTab === 'nasdaq' ? '_nasdaqData' : '_sp500Data';
    if (dataKey === tabDataKey) {
      this.setData({
        [`list[${idx}].trackingErrStr`]: value
      });
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