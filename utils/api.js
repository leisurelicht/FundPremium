// utils/api.js
// 数据源：腾讯行情（实时/K线）+ 东方财富基金（净值历史）+ 新浪（美股指数历史）
//
// 说明：
// - 腾讯 qt.gtimg.cn 返回 GBK 编码文本，但数字字段为 ASCII，仅按 "~" 解析数字即可
// - 腾讯 web.ifzq.gtimg.cn 返回 UTF-8 JSON
// - 东财 pingzhongdata 为 JS 变量文本，可正则提取
// - 新浪美股指数 K 线为 JSONP（IO([...])）

const MARKET_PREFIX = { sh: 'sh', sz: 'sz' };

/**
 * 腾讯行情批量接口
 * 例：https://qt.gtimg.cn/q=sh513100,sz159501
 */
const QUOTE_URL = 'https://qt.gtimg.cn/q=';

/**
 * 腾讯 K 线历史接口（返回 JSON）
 * param: sh513100,day,,,250,qfq
 */
const KLINE_URL = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';

/**
 * 东财基金数据中心（含净值历史，无需 Referer）
 * fund.eastmoney.com/pingzhongdata/513100.js
 */
const FUND_DATA_URL = 'https://fund.eastmoney.com/pingzhongdata/';

/**
 * 新浪美股指数 K 线（JSONP）
 * symbol: .NDX（纳斯达克100）、.INX（标普500）
 */
const SIN_INDEX_URL = 'https://stock.finance.sina.com.cn/usstock/api/jsonp.php/IO/US_MinKService.getDailyK';

// ==================== 实时批量行情 ====================

/**
 * 获取多只 ETF 实时行情（含参考净值 NAV）
 * @param {Array} etfs - [{ code, market }]
 * @returns {Promise<Object>} { items: [...], timestamp }
 */
function fetchQuotes(etfs) {
  const q = etfs.map(e => MARKET_PREFIX[e.market] + e.code).join(',');
  return new Promise((resolve, reject) => {
    wx.request({
      url: QUOTE_URL + q,
      method: 'GET',
      dataType: 'text',
      timeout: 12000,
      success(res) {
        if (res.statusCode !== 200 || typeof res.data !== 'string') {
          reject(new Error(`行情接口异常 HTTP ${res.statusCode}`));
          return;
        }
        const items = parseQuoteText(res.data);
        if (items.length === 0) {
          reject(new Error('行情数据为空'));
          return;
        }
        resolve({ items, timestamp: Date.now() });
      },
      fail(err) {
        reject(new Error('行情请求失败: ' + (err.errMsg || '')));
      }
    });
  });
}

/**
 * 解析腾讯批量行情文本
 * 每行：v_sh513100="1~名称~513100~2.142~...~1.7814~CNY~...";
 */
function parseQuoteText(text) {
  const items = [];
  const lines = text.split(';');
  for (const line of lines) {
    const idx = line.indexOf('=');
    if (idx < 0) continue;
    const valuePart = line.slice(idx + 1).trim();
    if (valuePart.length < 2 || valuePart[0] !== '"') continue;
    const body = valuePart.slice(1, -1); // 去掉两侧引号
    if (!body) continue;
    const fields = body.split('~');
    if (fields.length < 40) continue;
    items.push(parseQuoteFields(fields));
  }
  return items;
}

function parseQuoteFields(f) {
  const num = (i) => {
    const v = parseFloat(f[i]);
    return isNaN(v) ? null : v;
  };

  // 参考净值 NAV：位于 "CNY" 前一位
  // 该字段对国内ETF与净值几乎一致，对QDII为最新披露净值
  let nav = null;
  const cnyIdx = f.lastIndexOf('CNY');
  if (cnyIdx > 0) {
    const v = parseFloat(f[cnyIdx - 1]);
    if (!isNaN(v)) nav = v;
  }

  return {
    code: f[2],
    name: f[1],
    price: num(3),
    prevClose: num(4),
    open: num(5),
    change: num(31),
    changePct: num(32),
    high: num(33),
    low: num(34),
    amountWan: num(37),      // 成交额（万元）
    turnover: num(38),       // 换手率（%）
    nav: nav,                // 参考净值
    time: f[30] || ''        // 行情时间 20261109161457
  };
}

// ==================== K线历史 ====================

/**
 * 获取近一年日 K 线
 * @param {Object} etf - { code, market }
 * @param {number} count - 交易日数量（默认 250）
 * @returns {Promise<Object>} { klines: [...] }
 */
function fetchKline(etf, count = 250) {
  const symbol = MARKET_PREFIX[etf.market] + etf.code;
  return new Promise((resolve, reject) => {
    wx.request({
      url: KLINE_URL,
      method: 'GET',
      data: {
        param: `${symbol},day,,,${count},qfq`
      },
      dataType: 'json',
      timeout: 12000,
      success(res) {
        const d = res.data;
        if (!d || d.code !== 0 || !d.data || !d.data[symbol]) {
          reject(new Error('K线数据为空'));
          return;
        }
        const node = d.data[symbol];
        // qfqday 为前复权；day 为不复权
        const raw = node.qfqday || node.day || [];
        const klines = raw.map(parseKlineRow);
        if (klines.length === 0) {
          reject(new Error('K线数据为空'));
          return;
        }
        resolve({ klines });
      },
      fail(err) {
        reject(new Error('K线请求失败: ' + (err.errMsg || '')));
      }
    });
  });
}

/**
 * 腾讯 K 线行格式：[date, open, close, high, low, volume]
 */
function parseKlineRow(row) {
  return {
    date: row[0],
    open: parseFloat(row[1]) || 0,
    close: parseFloat(row[2]) || 0,
    high: parseFloat(row[3]) || 0,
    low: parseFloat(row[4]) || 0,
    volume: parseFloat(row[5]) || 0
  };
}

// ==================== 基金净值历史（东财） ====================

/**
 * 获取基金净值历史（用于跟踪误差）
 * @param {string} code - 基金代码
 * @returns {Promise<Object>} { navList: [{date, nav}] }
 */
function fetchFundNAV(code) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: FUND_DATA_URL + code + '.js',
      method: 'GET',
      dataType: 'text',
      timeout: 15000,
      success(res) {
        if (res.statusCode !== 200 || typeof res.data !== 'string') {
          reject(new Error('净值接口异常'));
          return;
        }
        const navList = extractNavTrend(res.data);
        if (!navList || navList.length === 0) {
          reject(new Error('净值数据为空'));
          return;
        }
        resolve({ navList });
      },
      fail(err) {
        reject(new Error('净值请求失败: ' + (err.errMsg || '')));
      }
    });
  });
}

/**
 * 从 pingzhongdata JS 文本中提取 Data_netWorthTrend
 * 格式：[{"x":1366819200000,"y":1.0,...}, ...]
 */
function extractNavTrend(text) {
  const key = 'var Data_netWorthTrend = ';
  const keyPos = text.indexOf(key);
  if (keyPos < 0) return [];
  const start = text.indexOf('[', keyPos);
  const end = text.indexOf('];', start);
  if (start < 0 || end < 0) return [];
  const jsonStr = text.slice(start, end + 1);
  let arr;
  try {
    arr = JSON.parse(jsonStr);
  } catch (e) {
    return [];
  }
  const list = [];
  for (const item of arr) {
    if (!item || typeof item.y !== 'number') continue;
    list.push({
      date: timestampToDate(item.x),
      nav: item.y
    });
  }
  return list;
}

function timestampToDate(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ==================== 美股指数历史（新浪） ====================

/**
 * 获取美股指数日 K 历史
 * @param {string} symbol - ".NDX" 或 ".INX"
 * @returns {Promise<Object>} { klines: [{date, close}] }
 */
function fetchIndexKline(symbol) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: SIN_INDEX_URL,
      method: 'GET',
      data: { symbol: symbol, ___qn: 3 },
      dataType: 'text',
      timeout: 15000,
      success(res) {
        if (res.statusCode !== 200 || typeof res.data !== 'string') {
          reject(new Error('指数接口异常'));
          return;
        }
        const text = res.data;
        const start = text.indexOf('IO(');
        if (start < 0) {
          reject(new Error('指数数据格式异常'));
          return;
        }
        const bodyStart = start + 3;
        const bodyEnd = text.lastIndexOf(')');
        let arr;
        try {
          arr = JSON.parse(text.slice(bodyStart, bodyEnd));
        } catch (e) {
          reject(new Error('指数数据解析失败'));
          return;
        }
        const klines = arr.map(item => ({
          date: item.d,
          close: parseFloat(item.c) || 0
        })).filter(k => k.date && k.close > 0);
        resolve({ klines });
      },
      fail(err) {
        reject(new Error('指数请求失败: ' + (err.errMsg || '')));
      }
    });
  });
}

// ==================== QDII Lens API ====================
//
// 文档：https://qdiilens.com/llms.txt
// 只读、无需认证；限额 120 次/分钟
// 所有响应为 { data, meta }；ma.as_of 为数据时点
//
// 注意：price_change_pct、indicative_premium_pct 等百分比字段
// **已 ×100**，直接格式化即可（例如 0.6182 → "0.62%"）。

const QDII_BASE = 'https://qdiilens.com/v1';

/**
 * 按指数拉溢价排行（列表页主力接口）
 * @param {string} indexSlug - "nasdaq-100" | "sp-500"
 * @returns {Promise<Object>} { items: [{fund, quote}], meta }
 */
function fetchRankings(indexSlug) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${QDII_BASE}/rankings/premiums`,
      method: 'GET',
      data: { index: indexSlug },
      dataType: 'json',
      timeout: 12000,
      success(res) {
        if (res.statusCode !== 200 || !res.data || !res.data.data) {
          reject(new Error('QDII Lens 排行接口异常'));
          return;
        }
        const raw = res.data.data;
        const items = raw.map(item => ({
          code: (item.fund && item.fund.code) || (item.quote && item.quote.code) || '',
          fund: item.fund || {},
          quote: item.quote || {},
          rules: item.rules || []
        }));
        resolve({ items, meta: res.data.meta || {} });
      },
      fail(err) {
        reject(new Error('QDII Lens 请求失败: ' + (err.errMsg || '')));
      }
    });
  });
}

/**
 * 单基金实时行情快照
 * @param {string} code - 基金代码
 * @returns {Promise<Object>} { code, quote }
 */
function fetchFundQuote(code) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${QDII_BASE}/funds/${code}/quote`,
      method: 'GET',
      dataType: 'json',
      timeout: 12000,
      success(res) {
        if (res.statusCode !== 200 || !res.data || !res.data.data) {
          reject(new Error('QDII Lens 报价接口异常'));
          return;
        }
        resolve({ code, ...res.data.data, meta: res.data.meta || {} });
      },
      fail(err) {
        reject(new Error('QDII Lens 报价请求失败: ' + (err.errMsg || '')));
      }
    });
  });
}

/**
 * 基金净值历史（轻量 JSON，替代 pingzhongdata 500KB）
 * @param {string} code - 基金代码
 * @returns {Promise<Object>} { navList: [{date, nav}] }
 */
function fetchNavHistory(code) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${QDII_BASE}/funds/${code}/nav-history`,
      method: 'GET',
      dataType: 'json',
      timeout: 15000,
      success(res) {
        if (res.statusCode !== 200 || !res.data || !res.data.data) {
          reject(new Error('QDII Lens 净值接口异常'));
          return;
        }
        const raw = res.data.data;
        if (!Array.isArray(raw) || raw.length === 0) {
          reject(new Error('QDII Lens 净值数据为空'));
          return;
        }
        const navList = raw
          .filter(i => i && typeof i.nav === 'number' && i.valuation_date)
          .map(i => ({ date: i.valuation_date, nav: i.nav }));
        resolve({ navList });
      },
      fail(err) {
        reject(new Error('QDII Lens 净值请求失败: ' + (err.errMsg || '')));
      }
    });
  });
}

// ==================== 交易时段 ====================

function isTradingHours() {
  const now = new Date();
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const t = now.getHours() * 100 + now.getMinutes();
  return (t >= 930 && t <= 1130) || (t >= 1300 && t <= 1500);
}

module.exports = {
  fetchQuotes,
  fetchKline,
  fetchFundNAV,
  fetchIndexKline,
  fetchRankings,
  fetchFundQuote,
  fetchNavHistory,
  isTradingHours,
  parseQuoteText
};