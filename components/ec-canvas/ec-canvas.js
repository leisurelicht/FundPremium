// components/ec-canvas/ec-canvas.js
// 内置 echarts 引用，避免属性传递时的序列化问题
const echarts = require('./echarts');

function compareVersion(v1, v2) {
  v1 = v1.split('.');
  v2 = v2.split('.');
  const len = Math.max(v1.length, v2.length);
  while (v1.length < len) v1.push('0');
  while (v2.length < len) v2.push('0');
  for (let i = 0; i < len; i++) {
    if (parseInt(v1[i]) > parseInt(v2[i])) return 1;
    if (parseInt(v1[i]) < parseInt(v2[i])) return -1;
  }
  return 0;
}

class WxCanvas {
  constructor(ctx, canvasId, isNew, canvasNode) {
    this.ctx = ctx;
    this.canvasId = canvasId;
    this.chart = null;
    this.isNew = isNew;
    if (isNew) {
      this.canvasNode = canvasNode;
    } else {
      this._initStyle(ctx);
    }
    this._initEvent();
  }

  getContext(contextType) {
    if (contextType === '2d') return this.ctx;
  }

  setChart(chart) { this.chart = chart; }
  attachEvent() {}
  detachEvent() {}

  _initStyle(ctx) {
    const styles = ['fillStyle', 'strokeStyle', 'globalAlpha', 'textAlign',
      'textBaseAlign', 'shadow', 'lineWidth', 'lineCap', 'lineJoin',
      'lineDash', 'miterLimit', 'fontSize'];
    styles.forEach(style => {
      Object.defineProperty(ctx, style, {
        set(value) {
          if ((style !== 'fillStyle' && style !== 'strokeStyle') ||
            (value !== 'none' && value !== null)) {
            ctx['set' + style.charAt(0).toUpperCase() + style.slice(1)](value);
          }
        }
      });
    });
    ctx.createRadialGradient = () => ctx.createCircularGradient(arguments);
  }

  _initEvent() {
    this.event = {};
    [{ wxName: 'touchStart', ecName: 'mousedown' },
     { wxName: 'touchMove', ecName: 'mousemove' },
     { wxName: 'touchEnd', ecName: 'mouseup' },
     { wxName: 'touchEnd', ecName: 'click' }]
      .forEach(name => {
        this.event[name.wxName] = (e) => {
          const touch = e.touches[0];
          this.chart.getZr().handler.dispatch(name.ecName, {
            zrX: name.wxName === 'tap' ? touch.clientX : touch.x,
            zrY: name.wxName === 'tap' ? touch.clientY : touch.y
          });
        };
      });
  }

  set width(w) { if (this.canvasNode) this.canvasNode.width = w; }
  get width() { return this.canvasNode ? this.canvasNode.width : 0; }
  set height(h) { if (this.canvasNode) this.canvasNode.height = h; }
  get height() { return this.canvasNode ? this.canvasNode.height : 0; }
}

Component({
  properties: {
    canvasId: {
      type: String,
      value: 'ec-canvas'
    },
    ec: {
      type: Object
    },
    forceUseOldCanvas: {
      type: Boolean,
      value: false
    }
  },

  data: {
    isUseNewCanvas: false
  },

  ready() {
    // 注册预处理：禁用 progressive（小程序 Canvas 不支持）
    echarts.registerPreprocessor(function (option) {
      if (option && option.series) {
        if (option.series.length > 0) {
          option.series.forEach(s => { s.progressive = 0; });
        } else if (typeof option.series === 'object') {
          option.series.progressive = 0;
        }
      }
    });

    if (!this.data.ec) {
      console.warn('ec-canvas 组件需绑定 ec 变量');
      return;
    }

    if (!this.data.ec.lazyLoad) {
      this.init();
    }
  },

  detached() {
    if (this.chart) {
      this.chart.dispose();
      this.chart = null;
    }
  },

  methods: {
    init(callback) {
      const version = wx.getSystemInfoSync().SDKVersion;
      const canUseNewCanvas = compareVersion(version, '2.9.0') >= 0;
      const isUseNewCanvas = canUseNewCanvas && !this.data.forceUseOldCanvas;
      this.setData({ isUseNewCanvas });

      if (isUseNewCanvas) {
        this.initByNewWay(callback);
      } else {
        if (compareVersion(version, '1.9.91') < 0) {
          console.error('微信基础库版本过低，需 >= 1.9.91');
          return;
        }
        this.initByOldWay(callback);
      }
    },

    initByOldWay(callback) {
      const ctx = wx.createCanvasContext(this.data.canvasId, this);
      const canvas = new WxCanvas(ctx, this.data.canvasId, false);
      echarts.setCanvasCreator(() => canvas);
      const canvasDpr = 1;
      wx.createSelectorQuery().in(this).select('.ec-canvas')
        .boundingClientRect(res => {
          if (typeof callback === 'function') {
            this.chart = callback(canvas, res.width, res.height, canvasDpr);
          } else if (this.data.ec && typeof this.data.ec.onInit === 'function') {
            this.chart = this.data.ec.onInit(canvas, res.width, res.height, canvasDpr);
          } else {
            this.triggerEvent('init', { canvas, width: res.width, height: res.height, canvasDpr });
          }
        }).exec();
    },

    initByNewWay(callback) {
      wx.createSelectorQuery().in(this).select('.ec-canvas')
        .fields({ node: true, size: true }).exec(res => {
          const canvasNode = res[0].node;
          this.canvasNode = canvasNode;
          const dpr = wx.getSystemInfoSync().pixelRatio;
          const w = res[0].width;
          const h = res[0].height;
          const ctx = canvasNode.getContext('2d');
          const canvas = new WxCanvas(ctx, this.data.canvasId, true, canvasNode);
          echarts.setCanvasCreator(() => canvas);

          if (typeof callback === 'function') {
            this.chart = callback(canvas, w, h, dpr);
          } else if (this.data.ec && typeof this.data.ec.onInit === 'function') {
            this.chart = this.data.ec.onInit(canvas, w, h, dpr);
          } else {
            this.triggerEvent('init', { canvas, width: w, height: h, dpr });
          }
        });
    },

    touchStart(e) {
      if (!this.chart || !e.touches.length) return;
      const t = e.touches[0];
      const h = this.chart.getZr().handler;
      h.dispatch('mousedown', { zrX: t.x, zrY: t.y });
      h.dispatch('mousemove', { zrX: t.x, zrY: t.y });
      h.processGesture(wrapTouch(e), 'start');
    },

    touchMove(e) {
      if (!this.chart || !e.touches.length) return;
      const t = e.touches[0];
      const h = this.chart.getZr().handler;
      h.dispatch('mousemove', { zrX: t.x, zrY: t.y });
      h.processGesture(wrapTouch(e), 'change');
    },

    touchEnd(e) {
      if (!this.chart) return;
      const t = e.changedTouches ? e.changedTouches[0] : {};
      const h = this.chart.getZr().handler;
      h.dispatch('mouseup', { zrX: t.x, zrY: t.y });
      h.dispatch('click', { zrX: t.x, zrY: t.y });
      h.processGesture(wrapTouch(e), 'end');
    }
  }
});

function wrapTouch(event) {
  for (let i = 0; i < event.touches.length; ++i) {
    event.touches[i].offsetX = event.touches[i].x;
    event.touches[i].offsetY = event.touches[i].y;
  }
  return event;
}