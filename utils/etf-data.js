// utils/etf-data.js
// ETF 代码池配置 & 计算逻辑

// 纳指100 ETF列表
const NASDAQ_100_ETFS = [
  { code: '513100', market: 'sh', name: '纳指ETF',        company: '国泰',    fullName: '国泰纳斯达克100ETF' },
  { code: '159501', market: 'sz', name: '纳斯达克100ETF',  company: '嘉实',    fullName: '嘉实纳斯达克100ETF' },
  { code: '513300', market: 'sh', name: '纳斯达克ETF',     company: '华夏',    fullName: '华夏纳斯达克100ETF' },
  { code: '159941', market: 'sz', name: '纳指ETF',        company: '广发',    fullName: '广发纳斯达克100ETF' },
  { code: '159659', market: 'sz', name: '纳斯达克100ETF',  company: '招商',    fullName: '招商纳斯达克100ETF' },
  { code: '159660', market: 'sz', name: '纳斯达克100ETF',  company: '汇添富',   fullName: '汇添富纳斯达克100ETF' },
  { code: '159696', market: 'sz', name: '纳斯达克100ETF',  company: '易方达',   fullName: '易方达纳斯达克100ETF' },
  { code: '513110', market: 'sh', name: '纳斯达克100ETF',  company: '华泰柏瑞', fullName: '华泰柏瑞纳斯达克100ETF' }
];

// 标普500 ETF列表
const SP500_ETFS = [
  { code: '513500', market: 'sh', name: '标普500ETF', company: '博时', fullName: '博时标普500ETF' },
  { code: '159612', market: 'sz', name: '标普500ETF', company: '国泰', fullName: '国泰标普500ETF' },
  { code: '159655', market: 'sz', name: '标普500ETF', company: '华夏', fullName: '华夏标普500ETF' },
  { code: '513650', market: 'sh', name: '标普500ETF', company: '南方', fullName: '南方标普500ETF' }
];

// 基准指数（新浪美股指数代码）
const BENCHMARK = {
  nasdaq: '.NDX',   // 纳斯达克100
  sp500: '.INX'     // 标普500
};

// 计算溢折率: (最新价 - 参考净值) / 参考净值 * 100
function calcPremium(price, nav) {
  if (!price || !nav || nav === 0) return null;
  return ((price - nav) / nav * 100);
}

// 格式化溢折率展示
function formatPremium(rate) {
  if (rate === null || rate === undefined) return '--';
  const sign = rate >= 0 ? '+' : '';
  return `${sign}${rate.toFixed(2)}%`;
}

// 涨跌颜色类名: 中国习惯 红涨绿跌
function getChangeClass(change) {
  if (change === null || change === undefined) return '';
  if (change > 0) return 'up';
  if (change < 0) return 'down';
  return 'flat';
}

// 格式化涨跌幅
function formatChange(change) {
  if (change === null || change === undefined) return '--';
  const sign = change >= 0 ? '+' : '';
  return `${sign}${change.toFixed(2)}%`;
}

// 格式化价格
function formatPrice(price) {
  if (price === null || price === undefined) return '--';
  return price.toFixed(3);
}

// 格式化成交额（元/万元）
function formatAmount(amountWan) {
  if (amountWan === null || amountWan === undefined) return '--';
  if (amountWan >= 10000) return (amountWan / 10000).toFixed(2) + '亿';
  if (amountWan >= 1) return amountWan.toFixed(0) + '万';
  if (amountWan === 0) return '0';
  return '--';
}

// 获取溢价率颜色类名
function getPremiumClass(rate) {
  if (rate === null || rate === undefined) return '';
  if (rate > 0.5) return 'premium-high';   // 高溢价 → 红色警告
  if (rate > 0) return 'premium';           // 溢价 → 橙红
  if (rate < -0.5) return 'discount';       // 折价 → 绿色
  return 'flat';
}

/**
 * 计算跟踪误差（年化）
 * 跟踪误差 = std(ETF 净值日收益率 - 基准指数日收益率) × sqrt(242)
 *
 * 针对 QDII ETF 优化：
 * - 跳过净值未更新日（abs(日收益) < 1e-6）避免 T+1 公布滞后带来的假性偏离
 * - 按净值日期直接匹配指数同日收益率
 *
 * @param {Array} navList   - [{date, nav}]
 * @param {Array} indexList - [{date, close}]
 */
function calcTrackingError(navList, indexList) {
  if (!navList || !indexList || navList.length < 20 || indexList.length < 20) {
    return null;
  }

  // 只取近一年（避免早期数据偏差放大误差）
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  const cutoff = oneYearAgo.toISOString().slice(0, 10); // YYYY-MM-DD

  // 指数日期→收盘价快速查找
  const idxMap = {};
  for (const item of indexList) {
    if (item.close > 0 && item.date >= cutoff) idxMap[item.date] = item.close;
  }

  // 净值按日期排序，仅取近一年
  const sortedNav = navList
    .filter(i => i.nav > 0 && i.date >= cutoff)
    .sort((a, b) => a.date.localeCompare(b.date));

  const diffs = [];

  for (let i = 1; i < sortedNav.length; i++) {
    const nPrev = sortedNav[i - 1];
    const nCur = sortedNav[i];
    if (nPrev.nav <= 0 || nCur.nav <= 0) continue;

    const nRet = (nCur.nav - nPrev.nav) / nPrev.nav;

    // 跳过净值未更新日：QDII 基金 T+1 公布，部分日期净值与上一日相同
    if (Math.abs(nRet) < 1e-6) continue;

    // 查找同一日历日的指数收盘价
    const iPrev = idxMap[nPrev.date];
    const iCur = idxMap[nCur.date];
    if (iPrev === undefined || iCur === undefined || iPrev === 0) continue;

    const iRet = (iCur - iPrev) / iPrev;
    diffs.push(nRet - iRet);
  }

  if (diffs.length < 20) return null;

  const mean = diffs.reduce((s, r) => s + r, 0) / diffs.length;
  const variance = diffs.reduce((s, r) => s + (r - mean) ** 2, 0) / (diffs.length - 1);

  return Math.sqrt(variance) * Math.sqrt(242);
}

module.exports = {
  NASDAQ_100_ETFS,
  SP500_ETFS,
  BENCHMARK,
  calcPremium,
  formatPremium,
  getChangeClass,
  formatChange,
  formatPrice,
  formatAmount,
  getPremiumClass,
  calcTrackingError
};