// pages/detail/detail.js - ETF详情页逻辑
const echarts = require('../../components/ec-canvas/echarts');
const {
  BENCHMARK, calcPremium, formatPremium, formatPrice, formatChange,
  formatAmount, getChangeClass, getPremiumClass, calcTrackingError
} = require('../../utils/etf-data');
const { fetchQuotes, fetchKline, fetchFundNAV, fetchIndexKline } = require('../../utils/api');

Page({
  data: {
    // ETF 基本信息
    code: '',
    market: '',
    name: '',
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

    // 状态
    loading: true,
    error: '',

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
    const fullName = decodeURIComponent(options.fullName || '');
    this.setData({ code, market, name, fullName });

    // 设置 echarts 初始化回调
    this.setData({
      'ec.onInit': this.initChart.bind(this)
    });

    this.loadAllData();
  },

  // ========== 数据加载 ==========

  async loadAllData() {
    this.setData({ loading: true, error: '' });

    const etf = { code: this.data.code, market: this.data.market };

    try {
      // 并行获取实时行情和近一年K线
      const [quoteRes, klineRes] = await Promise.all([
        fetchQuotes([etf]),
        fetchKline(etf, 250)
      ]);

      const quote = (quoteRes.items || [])[0] || {};
      this.processQuote(quote);

      this._klines = klineRes.klines || [];

      this.setData({ ecReady: true, loading: false });

      // 异步计算跟踪误差（依赖净值历史+指数历史，可能失败）
      this.loadTrackingError();
    } catch (err) {
      console.error('详情页加载失败:', err);
      this.setData({
        loading: false,
        error: this.buildErrorMessage(err)
      });
    }
  },

  processQuote(quote) {
    const price = quote.price;
    const nav = quote.nav;
    const changePct = quote.changePct;
    const premium = calcPremium(price, nav);

    this.setData({
      price, nav, change: changePct, premium,
      open: quote.open, high: quote.high, low: quote.low,
      prevClose: quote.prevClose, amount: quote.amountWan,
      turnover: quote.turnover,

      priceStr: formatPrice(price),
      changeStr: formatChange(changePct),
      navStr: formatPrice(nav),
      openStr: formatPrice(quote.open),
      highStr: formatPrice(quote.high),
      lowStr: formatPrice(quote.low),
      prevCloseStr: formatPrice(quote.prevClose),
      amountStr: formatAmount(quote.amountWan),
      turnoverStr: quote.turnover !== null && quote.turnover !== undefined
        ? quote.turnover.toFixed(2) + '%' : '--',

      premiumStr: formatPremium(premium),
      premiumClass: getPremiumClass(premium),
      changeClass: getChangeClass(changePct)
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
        fetchFundNAV(this.data.code),
        fetchIndexKline(benchmark)
      ]);

      const trackingErr = calcTrackingError(navRes.navList, idxRes.klines);
      if (trackingErr === null) {
        this.setData({ trackingErrStr: '数据不足', trackingErrLoading: false });
      } else {
        this.setData({
          trackingErrStr: (trackingErr * 100).toFixed(2) + '%',
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
    chart.setOption(this.buildChartOption());
    return chart;
  },

  buildChartOption() {
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