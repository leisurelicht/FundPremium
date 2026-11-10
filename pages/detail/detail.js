// pages/detail/detail.js - ETF详情页逻辑
const echarts = require('../../components/ec-canvas/echarts');
const {
  BENCHMARK, getChangeClass, getPremiumClass, calcTrackingError
} = require('../../utils/etf-data');
const { fetchFundQuote, fetchQuotes, fetchKline, fetchNavHistory, fetchBenchmark, fetchPremiumHistory, fetchFundFee } = require('../../utils/api');

Page({
  data: {
    // ETF 基本信息
    code: '',
    market: '',
    name: '',
    company: '',
    fullName: '',

    // 行情
    price: null, change: null, nav: null,
    open: null, high: null, low: null,
    prevClose: null, amount: null, turnover: null,
    premium: null,

    // 格式化
    priceStr: '--', changeStr: '--', navStr: '--',
    openStr: '--', highStr: '--', lowStr: '--',
    prevCloseStr: '--', amountStr: '--', turnoverStr: '--',
    premiumStr: '--', premiumClass: '',
    changeClass: '',
    trackingErrStr: '--',
    trackingErrLoading: false,
    feeStr: '--',

    // 状态
    loading: true,
    error: '',

    // 图表模式：kline = 价格K线，premium = 溢价率走势
    chartMode: 'kline',
    premiumEmpty: false,

    // echarts
    ecReady: false,
    ec: {
      lazyLoad: false,
      onInit: null
    }
  },

  onLoad(options) {
    const code = options.code || '';
    const market = options.market || '';
    const name = decodeURIComponent(options.name || '');
    const company = decodeURIComponent(options.company || '');
    const fullName = decodeURIComponent(options.fullName || '');
    this.setData({ code, market, name, company, fullName });

    // 设置 echarts 初始化回调
    this.setData({
      'ec.onInit': this.initChart.bind(this)
    });

    this.loadAllData();
  },

  // ========== 数据加载 ==========

  async loadAllData() {
    this.setData({ loading: true, error: '' });

    try {
      // 并行：QDII Lens 行情 + 腾讯 OHLC + K线 + 溢价历史
      const etf = { code: this.data.code, market: this.data.market };
      const [quoteRes, txRes, klineRes, premiumRes, feeRes] = await Promise.all([
        fetchFundQuote(this.data.code),
        fetchQuotes([etf]),
        fetchKline(etf, 250),
        fetchPremiumHistory(this.data.code, '1y').catch(e => {
          console.warn('溢价历史加载失败:', e.message || e);
          return null;
        }),
        fetchFundFee(this.data.code).catch(e => {
          console.warn('费率加载失败:', e.message || e);
          return null;
        })
      ]);

      this.processQuote(quoteRes, txRes);
      this._klines = klineRes.klines || [];

      const points = (premiumRes && premiumRes.points) || [];
      this._premiumPoints = points.filter(p => p.premium !== null);

      this.setData({
        ecReady: true,
        loading: false,
        premiumEmpty: this._premiumPoints.length === 0,
        feeStr: (feeRes && feeRes.totalPct != null) ? feeRes.totalPct.toFixed(2) + '%/年' : '--'
      });

      // 异步计算跟踪误差
      this.loadTrackingError();
    } catch (err) {
      console.error('详情页加载失败:', err);
      this.setData({
        loading: false,
        error: this.buildErrorMessage(err)
      });
    }
  },

  // 混合 QDII Lens（溢价/净值）+ 腾讯（OHLC/换手率）
  processQuote(q, txRes) {
    const tx = (txRes && txRes.items && txRes.items[0]) || {};

    const price      = q.market_price;
    const nav        = q.nav;
    const iopv       = q.iopv;
    const changePct  = q.price_change_pct;
    const premiumPct = q.indicative_premium_pct;
    const turnover   = q.turnover_cny ? q.turnover_cny / 10000 : null;
    const open       = tx.open;
    const high       = tx.high;
    const low        = tx.low;
    const txTurnover = tx.turnover;

    const fmtPct = (v) => {
      if (v == null) return '--';
      const sign = v >= 0 ? '+' : '';
      return `${sign}${v.toFixed(2)}%`;
    };

    this.setData({
      price, nav, iopv, change: changePct, premium: premiumPct,
      open, high, low,
      prevClose: q.prev_close, amount: turnover,

      priceStr:     price != null ? price.toFixed(3) : '--',
      changeStr:    fmtPct(changePct),
      navStr:       iopv != null ? iopv.toFixed(3) : '--',
      openStr:      open != null ? open.toFixed(3) : '--',
      highStr:      high != null ? high.toFixed(3) : '--',
      lowStr:       low != null ? low.toFixed(3) : '--',
      prevCloseStr: q.prev_close != null ? q.prev_close.toFixed(3) : '--',
      amountStr:    turnover != null ? (turnover >= 10000 ? (turnover/10000).toFixed(2)+'亿' : turnover.toFixed(0)+'万') : '--',
      turnoverStr:  txTurnover != null ? txTurnover.toFixed(2) + '%' : '--',

      premiumStr:   fmtPct(premiumPct),
      premiumClass: getPremiumClass(premiumPct),
      changeClass:  getChangeClass(changePct)
    });
  },

  /**
   * 跟踪误差：ETF净值日收益率 与 基准指数日收益率 差值的年化标准差
   * 纳指100 -> .NDX，标普500 -> .INX
   */
  async loadTrackingError() {
    // 通过代码判断所属指数：标普500 ETF -> .INX；其余 -> .NDX
    const benchmark = this.isSP500Code(this.data.code)
      ? BENCHMARK.sp500
      : BENCHMARK.nasdaq;

    this.setData({ trackingErrLoading: true });

    try {
      const [navRes, idxRes] = await Promise.all([
        fetchNavHistory(this.data.code),
        fetchBenchmark(benchmark)
      ]);

      const trackingErr = calcTrackingError(navRes.navList, idxRes.klines);
      const suffix = this.isSP500Code(this.data.code) ? ' SPY' : ' QQQ';
      if (trackingErr === null) {
        this.setData({ trackingErrStr: '数据不足', trackingErrLoading: false });
      } else {
        this.setData({
          trackingErrStr: (trackingErr * 100).toFixed(2) + '%' + suffix,
          trackingErrLoading: false
        });
      }
    } catch (err) {
      console.warn('跟踪误差计算失败:', err);
      this.setData({ trackingErrStr: '--', trackingErrLoading: false });
    }
  },

  // 判断是否标普500 ETF
  isSP500Code(code) {
    return ['513500', '159612', '159655', '513650'].indexOf(code) >= 0;
  },

  // ========== 图表初始化 ==========

  initChart(canvas, width, height, dpr) {
    const chart = echarts.init(canvas, null, {
      width: width,
      height: height,
      devicePixelRatio: dpr
    });
    canvas.setChart(chart);
    this._chart = chart;
    chart.setOption(this.buildChartOption());
    return chart;
  },

  // 切换图表：价格K线 / 溢价率走势
  switchChart(e) {
    const mode = e.currentTarget.dataset.mode;
    if (mode === this.data.chartMode) return;

    this.setData({ chartMode: mode });

    if (this._chart) {
      this._chart.setOption(this.buildChartOption(), true);
    }
  },

  buildChartOption() {
    return this.data.chartMode === 'premium'
      ? this.buildPremiumOption()
      : this.buildKlineOption();
  },

  // ========== 溢价率走势图 ==========

  buildPremiumOption() {
    const points = this._premiumPoints || [];
    const dates = points.map(p => p.date);
    const values = points.map(p => p.premium);

    if (points.length === 0) {
      return {
        backgroundColor: '#fafbfd',
        title: {
          text: '暂无溢价历史数据',
          left: 'center',
          top: 'middle',
          textStyle: { fontSize: 12, color: '#b0b5c0', fontWeight: 'normal' }
        }
      };
    }

    const last = values[values.length - 1];

    return {
      backgroundColor: '#fafbfd',
      animation: false,
      grid: { left: 6, right: 14, top: 30, bottom: 22, containLabel: true },
      xAxis: {
        type: 'category',
        data: dates,
        boundaryGap: false,
        axisLine: { lineStyle: { color: '#e0e0e0' } },
        axisTick: { show: false },
        axisLabel: {
          fontSize: 9,
          color: '#999',
          formatter: v => {
            if (!v) return '';
            const p = v.split('-');
            return p[1] ? p[1] + '/' + p[2] : v;
          },
          interval: Math.max(Math.floor(dates.length / 5), 1)
        }
      },
      yAxis: {
        type: 'value',
        scale: true,
        splitNumber: 4,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          fontSize: 9,
          color: '#999',
          formatter: v => v.toFixed(0) + '%'
        },
        splitLine: { lineStyle: { color: '#f0f0f0', type: 'dashed' } }
      },
      tooltip: { trigger: 'axis' },
      series: [{
        name: '溢折率',
        type: 'line',
        data: values,
        smooth: true,
        symbol: 'none',
        connectNulls: true,
        lineStyle: { width: 1.5, color: '#e8453c' },
        areaStyle: { color: 'rgba(232,69,60,0.10)' },
        markLine: {
          silent: true,
          symbol: 'none',
          lineStyle: { color: '#c9ced8', type: 'dashed', width: 1 },
          data: [{ yAxis: 0 }],
          label: { show: false }
        },
        markPoint: {
          symbol: 'circle',
          symbolSize: 6,
          itemStyle: { color: '#e8453c' },
          label: {
            show: true,
            position: 'left',
            formatter: () => (last >= 0 ? '+' : '') + last.toFixed(2) + '%',
            fontSize: 10,
            color: '#e8453c'
          },
          data: [{ coord: [dates[dates.length - 1], last] }]
        }
      }]
    };
  },

  // ========== 价格K线图 ==========

  buildKlineOption() {
    const klines = this._klines || [];
    const dates = klines.map(k => k.date);
    const ohlc = klines.map(k => [k.open, k.close, k.low, k.high]);
    const volumes = klines.map(k => k.volume);

    const closes = klines.map(k => k.close);
    const ma5 = calcMA(closes, 5);
    const ma10 = calcMA(closes, 10);
    const ma20 = calcMA(closes, 20);

    return {
      backgroundColor: '#fafbfd',
      animation: false,
      legend: {
        data: ['K线', 'MA5', 'MA10', 'MA20'],
        top: 6,
        left: 'center',
        itemWidth: 14,
        itemHeight: 8,
        textStyle: { fontSize: 10, color: '#888' }
      },
      grid: [
        { left: 8, right: 8, top: 40, height: '55%' },
        { left: 8, right: 8, top: '74%', height: '15%' }
      ],
      xAxis: [
        {
          type: 'category',
          data: dates,
          gridIndex: 0,
          axisLine: { lineStyle: { color: '#e0e0e0' } },
          axisTick: { show: false },
          axisLabel: {
            show: true,
            fontSize: 9,
            color: '#999',
            formatter: function (val) {
              if (!val) return '';
              const parts = val.split('-');
              return parts[1] ? parts[1] + '/' + parts[2] : val;
            },
            interval: Math.max(Math.floor(dates.length / 6), 1)
          },
          splitLine: { show: false }
        },
        {
          type: 'category',
          data: dates,
          gridIndex: 1,
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { show: false },
          splitLine: { show: false }
        }
      ],
      yAxis: [
        {
          type: 'value',
          gridIndex: 0,
          scale: true,
          splitNumber: 3,
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: {
            fontSize: 9,
            color: '#999',
            formatter: function (val) { return val.toFixed(3); }
          },
          splitLine: { lineStyle: { color: '#f0f0f0', type: 'dashed' } },
          position: 'right'
        },
        {
          type: 'value',
          gridIndex: 1,
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { show: false },
          splitLine: { show: false }
        }
      ],
      dataZoom: [
        { type: 'inside', xAxisIndex: [0, 1], start: 50, end: 100 }
      ],
      series: [
        {
          name: 'K线',
          type: 'candlestick',
          data: ohlc,
          xAxisIndex: 0,
          yAxisIndex: 0,
          itemStyle: {
            color: '#e8453c',
            color0: '#1cad6d',
            borderColor: '#e8453c',
            borderColor0: '#1cad6d'
          }
        },
        {
          name: 'MA5',
          type: 'line',
          data: ma5,
          xAxisIndex: 0,
          yAxisIndex: 0,
          smooth: true,
          lineStyle: { width: 1, color: '#f5a623' },
          symbol: 'none'
        },
        {
          name: 'MA10',
          type: 'line',
          data: ma10,
          xAxisIndex: 0,
          yAxisIndex: 0,
          smooth: true,
          lineStyle: { width: 1, color: '#4d8af0' },
          symbol: 'none'
        },
        {
          name: 'MA20',
          type: 'line',
          data: ma20,
          xAxisIndex: 0,
          yAxisIndex: 0,
          smooth: true,
          lineStyle: { width: 1, color: '#9b59b6' },
          symbol: 'none'
        },
        {
          name: '成交量',
          type: 'bar',
          data: volumes,
          xAxisIndex: 1,
          yAxisIndex: 1,
          itemStyle: {
            color: function (params) {
              const idx = params.dataIndex;
              if (idx >= ohlc.length) return '#ccc';
              return ohlc[idx][1] >= ohlc[idx][0] ? '#e8453c' : '#1cad6d';
            }
          }
        }
      ]
    };
  },

  buildErrorMessage(err) {
    const msg = (err && err.message) || '未知错误';
    if (msg.indexOf('HTTP') >= 0 || msg.indexOf('请求失败') >= 0) {
      return '网络请求失败，请检查开发者工具「不校验合法域名」设置';
    }
    return msg;
  }
});

// 计算移动平均线
function calcMA(data, period) {
  const result = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      result.push('-');
    } else {
      let sum = 0;
      for (let j = 0; j < period; j++) {
        sum += data[i - j];
      }
      result.push(+(sum / period).toFixed(3));
    }
  }
  return result;
}