// pages/index/index.js - 主列表页逻辑
// 行情 + 溢价由 QDII Lens API 提供；跟踪误差后台加载
const { NASDAQ_100_ETFS, SP500_ETFS, BENCHMARK,
  getChangeClass, formatChange, formatAmount, getPremiumClass,
  calcTrackingError } = require('../../utils/etf-data');
const { fetchRankings, fetchNavHistory, fetchIndexKline, isTradingHours } = require('../../utils/api');

// 构建代码 → ETF 元数据映射（用来自动匹配基金公司名和简称）
const ETF_MAP = {};
for (const e of NASDAQ_100_ETFS.concat(SP500_ETFS)) {
  ETF_MAP[e.code] = e;
}

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
      // 纳指100 + 标普500 并行请求
      const [nasdaqRes, sp500Res] = await Promise.all([
        fetchRankings('nasdaq-100'),
        fetchRankings('sp-500')
      ]);

      this._nasdaqData = this.mapRankings(NASDAQ_100_ETFS, nasdaqRes.items);
      this._sp500Data  = this.mapRankings(SP500_ETFS, sp500Res.items);

      this.updateListData();

      this.setData({
        isTrading: isTradingHours(),
        lastUpdate: this.formatTime(new Date()),
        loading: false,
        refreshing: false
      });

      // 后台加载跟踪误差（不阻塞行情展示）
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
   * 将 QDII Lens 排行数据映射为卡片格式
   *
   * API 返回的百分比字段（price_change_pct / indicative_premium_pct）
   * 已经 ×100，直接用 .toFixed(2) 显示即可。
   */
  mapRankings(etfPool, items) {
    return items
      .filter(item => ETF_MAP[item.code])
      .map(item => {
        const meta  = ETF_MAP[item.code] || {};
        const q     = item.quote || {};
        const rules = item.rules || [];

        // 从 rules 中提取场内申购状态（etf_create 动作）
        const subs = rules.find(r => (r.action || '').includes('create'));
        const subStatus = subs ? subs.status : null;
        const subLabels = {
          suspended: '暂停申购',
          limited:   '限大额',
          open:      '开放'
        };

        const price      = q.market_price;
        const changePct  = q.price_change_pct;             // 已 ×100，如 0.62 → 0.62%
        const premiumPct = q.indicative_premium_pct;       // 已 ×100，如 11.14 → 11.14%
        const nav        = q.nav;
        const iopv       = q.iopv;

        const formatPct = (v) => {
          if (v == null) return '--';
          const sign = v >= 0 ? '+' : '';
          return `${sign}${v.toFixed(2)}%`;
        };

        return {
          code:          meta.code,
          market:        meta.market,
          name:          (item.fund && item.fund.name) || meta.name,
          company:       meta.company,
          fullName:      meta.fullName,
          price:         price,
          nav:           nav,
          iopv:          iopv,
          change:        changePct,
          premium:       premiumPct,
          open:          null,
          high:          null,
          low:           null,
          prevClose:     q.prev_close,
          amount:        q.turnover_cny ? q.turnover_cny / 10000 : null, // 元 → 万元
          turnover:      null,
          priceStr:      price != null ? price.toFixed(3) : '--',
          changeStr:     formatPct(changePct),
          changeClass:   getChangeClass(changePct),
          premiumStr:    formatPct(premiumPct),
          premiumClass:  getPremiumClass(premiumPct),
          iopvStr:       iopv != null ? iopv.toFixed(3) : '--',
          prevCloseStr:  q.prev_close != null ? q.prev_close.toFixed(3) : '--',
          amountStr:     formatAmount(q.turnover_cny ? q.turnover_cny / 10000 : null),
          trackingErrStr: '--',
          subStatus:     subStatus,
          subLabel:      subLabels[subStatus] || '',
          quoteTime:     q.trading_date || ''
        };
      });
  },

  // ========== 跟踪误差（后台渐进加载） ==========

  /**
   * 在行情展示后，后台串行加载跟踪误差
   *
   * 指数 K 线在所有 ETF 间共享（同 Tab 共用同一指数），
   * ETF 净值历史逐个串行拉取，避免并发 500KB×12 把网络撑爆。
   * 每算完一只基金就立即更新对应卡片，用户看到数字一个个冒出来。
   */
  async loadTrackingErrors() {
    // 同时拉纳指和标普两组——后台可以并行
    this.loadGroupTrackingError(NASDAQ_100_ETFS, '_nasdaqData', BENCHMARK.nasdaq);
    this.loadGroupTrackingError(SP500_ETFS, '_sp500Data', BENCHMARK.sp500);
  },

  async loadGroupTrackingError(etfList, dataKey, indexSymbol) {
    let idxKlines = null;
    try {
      idxKlines = (await fetchIndexKline(indexSymbol)).klines;
    } catch (e) {
      console.warn(`指数 ${indexSymbol} 加载失败:`, e);
      return;
    }

    for (const etf of etfList) {
      try {
        const navRes = await fetchNavHistory(etf.code);
        const te = calcTrackingError(navRes.navList, idxKlines);
        const str = te !== null ? (te * 100).toFixed(2) + '%' : '数据不足';
        this.updateTrackingError(dataKey, etf.code, str);
      } catch (e) {
        console.warn(`跟踪误差 ${etf.code} 失败:`, e);
      }
    }
  },

  /**
   * 更新某张卡片的跟踪误差文本
   */
  updateTrackingError(dataKey, code, value) {
    const arr = this[dataKey];
    if (!arr) return;
    const idx = arr.findIndex(item => item.code === code);
    if (idx < 0) return;

    // 就地更新缓存数据
    arr[idx].trackingErrStr = value;

    // 如果当前 Tab 正好显示这一组，同步更新视图
    const tabDataKey = this.data.activeTab === 'nasdaq' ? '_nasdaqData' : '_sp500Data';
    if (dataKey === tabDataKey) {
      this.setData({
        [`list[${idx}].trackingErrStr`]: value
      });
    }
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