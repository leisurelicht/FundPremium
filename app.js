// app.js
App({
  onLaunch() {
    // 获取系统信息
    const systemInfo = wx.getSystemInfoSync();
    this.globalData.systemInfo = systemInfo;
    this.globalData.statusBarHeight = systemInfo.statusBarHeight;
  },

  globalData: {
    systemInfo: null,
    statusBarHeight: 0
  }
});