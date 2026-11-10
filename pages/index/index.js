// pages/index/index.js - 主列表页逻辑
const { NASDAQ_100_ETFS, SP500_ETFS, calcPremium,
  formatPremium, getChangeClass, formatChange, formatPrice,
  formatAmount, getPremiumClass } = require('../../utils/etf-data');
const { fetchQuotes, isTradingHours } = require('../../utils/api');

// 刷新间隔（毫秒）
const REFRESH_INTERVAL = 5000;

Page({
  data: {
    activeTab: 'nasdaq',     // nasdaq | sp500
    list: [],                // 当前展示的 ETF 列表
    loading: true,
    refreshing: false,
    error: '',
    lastUpdate: '',
    isTrading: true
  },

  // 缓存全量数据
  _nasdaqData: [],
  _sp500Data: [],
  _refreshTimer: null,

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
      // 将纳指100与标普500合并一次请求，减少网络往返
      const allEtfs = NASDAQ_100_ETFS.concat(SP500_ETFS);
      const res = await fetchQuotes(allEtfs);

      this._nasdaqData = this.mergeQuoteData(NASDAQ_100_ETFS, res.items);
      this._sp500Data = this.mergeQuoteData(SP500_ETFS, res.items);

      this.updateListData();

      this.setData({
        isTrading: isTradingHours(),
        lastUpdate: this.formatTime(new Date()),
        loading: false,
        refreshing: false
      });
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
   * 将行情数据合并到ETF元数据中
   */
  mergeQuoteData(etfMeta, quoteItems) {
    return etfMeta.map(etf => {
      const quote = quoteItems.find(q => q.code === etf.code) || {};

      const price = quote.price;
      const nav = quote.nav;
      const premium = calcPremium(price, nav);
      const changePct = quote.changePct;

      return {
        ...etf,
        price: price,
        nav: nav,
        change: changePct,
        open: quote.open,
        high: quote.high,
        low: quote.low,
        prevClose: quote.prevClose,
        amount: quote.amountWan,
        premium: premium,
        premiumStr: formatPremium(premium),
        premiumClass: getPremiumClass(premium),
        priceStr: formatPrice(price),
        changeStr: formatChange(changePct),
        changeClass: getChangeClass(changePct),
        iopvStr: formatPrice(nav),
        prevCloseStr: formatPrice(quote.prevClose),
        amountStr: formatAmount(quote.amountWan),
        trackingErrStr: '--',
        quoteTime: quote.time || ''
      };
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
    const { code, market, name, fullname } = e.currentTarget.dataset;
    wx.navigateTo({
      url: `/pages/detail/detail?code=${code}&market=${market}&name=${encodeURIComponent(name)}&fullName=${encodeURIComponent(fullname || '')}`
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