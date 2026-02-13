const Store = {
  // 获取数据
  get: (key) => new Promise((resolve, reject) => {
    // 判断是否为 Chrome 扩展环境 且 具有 storage 权限
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get([key], (result) => {
        const err = chrome.runtime?.lastError;
        if (err) return reject(err);

        // 注意：不要用 result[key] || null，否则 [] / 0 / "" 会被误判成 null
        if (Object.prototype.hasOwnProperty.call(result, key)) {
          resolve(result[key]);
        } else {
          resolve(null);
        }
      });
    } else {
      // Web 环境使用 localStorage
      const val = localStorage.getItem(key);
      try {
        // 尝试解析 JSON，如果解析失败（比如只是存了纯字符串）则返回原值
        resolve(val ? JSON.parse(val) : null);
      } catch (e) {
        resolve(val);
      }
    }
  }),

  // 保存数据
  set: (key, value) => new Promise((resolve, reject) => {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ [key]: value }, () => {
        const err = chrome.runtime?.lastError;
        if (err) return reject(err);
        resolve();
      });
    } else {
      // Web 环境
      const valToStore = typeof value === 'object' ? JSON.stringify(value) : value;
      localStorage.setItem(key, valToStore);
      resolve();
    }
  })
};
