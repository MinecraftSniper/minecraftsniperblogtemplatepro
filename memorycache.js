const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------- 固定路径 ----------
const MEMORY_CACHE_PATH = path.join(__dirname, 'memorycache.json');

// ---------- 读取内存配置（缺文件或格式错误则报错退出） ----------
function getMemoryConfig() {
  try {
    const raw = fs.readFileSync(MEMORY_CACHE_PATH, 'utf-8');
    const config = JSON.parse(raw);
    
    // 校验必要字段
    if (config.enable === undefined) {
      console.error('❌ memorycache.json 缺少 "enable" 字段（true/false/auto）');
      process.exit(1);
    }
    if (config.enable !== 'true' && config.enable !== 'false' && config.enable !== 'auto') {
      console.error(`❌ memorycache.json 中 "enable" 的值无效：${config.enable}（应为 true/false/auto）`);
      process.exit(1);
    }
    if (config.enable === 'true' && typeof config.maxMemoryMB !== 'number') {
      console.error('❌ memorycache.json 中 "maxMemoryMB" 必须是数字（仅在 enable=true 时生效）');
      process.exit(1);
    }
    
    return {
      enable: config.enable,
      maxMemoryMB: config.maxMemoryMB || 50
    };
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(`❌ 内存配置文件缺失：${MEMORY_CACHE_PATH}`);
      console.error('   请创建该文件，或检查 server.js 中的 ensureMemoryCacheFile() 是否已执行');
    } else {
      console.error(`❌ 读取 memorycache.json 失败：`, err.message);
    }
    process.exit(1);
  }
}

// ---------- 获取系统内存信息 ----------
function getSystemMemory() {
  const totalMem = os.totalmem();      // 总内存（字节）
  const freeMem = os.freemem();        // 可用内存（字节）
  const usedMem = totalMem - freeMem;
  const usedPercent = (usedMem / totalMem) * 100;
  const freePercent = (freeMem / totalMem) * 100;
  const totalMemMB = totalMem / 1024 / 1024;
  
  return { totalMem, freeMem, usedMem, usedPercent, freePercent, totalMemMB };
}

// ---------- 内存策略决策 ----------
function getCacheDecision() {
  const memConfig = getMemoryConfig();
  const memInfo = getSystemMemory();
  const { usedPercent, freePercent, totalMemMB } = memInfo;

  // 1. 完全禁用模式（false）
  if (memConfig.enable === 'false') {
    return {
      useCache: false,
      limitMB: 0,
      reason: '用户手动禁用缓存（enable=false）',
      mode: 'false'
    };
  }

  // 2. 自动模式（auto）
  if (memConfig.enable === 'auto') {
    // 可用内存 < 30% 时禁用
    if (freePercent < 30) {
      return {
        useCache: false,
        limitMB: 0,
        reason: `Auto 模式：可用内存仅 ${freePercent.toFixed(1)}%，低于 30% 阈值`,
        mode: 'auto'
      };
    }
    // 可用内存充足，动态调整缓存上限（总内存的 40%~60%）
    const ratio = Math.min(0.6, Math.max(0.4, freePercent / 100));
    const limitMB = totalMemMB * ratio;
    return {
      useCache: true,
      limitMB: limitMB,
      reason: `Auto 模式：可用内存 ${freePercent.toFixed(1)}%，动态上限 ${limitMB.toFixed(0)}MB`,
      mode: 'auto'
    };
  }

  // 3. 用户手动模式（true）
  // enable === 'true'
  const maxMemoryMB = memConfig.maxMemoryMB || 50;
  if (maxMemoryMB <= 0) {
    return {
      useCache: false,
      limitMB: 0,
      reason: '用户设置 maxMemoryMB ≤ 0，禁用缓存',
      mode: 'true'
    };
  }

  // True 模式下保留 20% 安全阀
  if (freePercent < 20) {
    return {
      useCache: false,
      limitMB: 0,
      reason: `⚠️ 系统可用内存仅 ${freePercent.toFixed(1)}%，低于 20% 安全阀，强制禁用`,
      mode: 'true'
    };
  }

  return {
    useCache: true,
    limitMB: maxMemoryMB,
    reason: `用户模式：缓存上限 ${maxMemoryMB}MB`,
    mode: 'true'
  };
}

// ---------- 计算当前缓存数据大小（单位 MB） ----------
function calculateCacheSize(cache) {
  let size = 0;
  if (cache.config) size += JSON.stringify(cache.config).length;
  if (cache.home) size += cache.home.length;
  if (cache.about) size += cache.about.length;
  if (cache.posts) {
    cache.posts.forEach(p => {
      size += (p.id?.length || 0) + (p.html?.length || 0);
    });
  }
  if (cache.moments) {
    cache.moments.forEach(m => {
      size += (m.id?.length || 0) + (m.html?.length || 0);
    });
  }
  return Math.round(size / 1024 / 1024 * 100) / 100; // MB，保留两位小数
}

// ---------- 导出接口 ----------
module.exports = {
  getMemoryConfig,
  getSystemMemory,
  getCacheDecision,
  calculateCacheSize
};