const express = require('express');
const fs = require('fs');
const path = require('path');
const util = require('util');
const chokidar = require('chokidar');
const marked = require('marked');

// ============================================================
// 日志系统（控制台 + 文件）
// ============================================================
const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  NONE: 4
};

const CURRENT_LOG_LEVEL = LOG_LEVELS.DEBUG;

// 确保日志目录存在
const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function log(level, message, ...args) {
  if (CURRENT_LOG_LEVEL > level) return;
  const timestamp = new Date().toLocaleString('zh-CN', { hour12: false });
  const levelNames = {
    [LOG_LEVELS.DEBUG]: '🐞 DEBUG',
    [LOG_LEVELS.INFO]: 'ℹ️ INFO',
    [LOG_LEVELS.WARN]: '⚠️ WARN',
    [LOG_LEVELS.ERROR]: '❌ ERROR'
  };
  const prefix = levelNames[level] || '📌 LOG';
  const formatted = util.format(message, ...args);
  const logLine = `[${timestamp}] [${prefix}] ${formatted}`;

  console.log(logLine);
  try {
    const dateStr = new Date().toISOString().slice(0, 10);
    const logFile = path.join(LOG_DIR, `app-${dateStr}.log`);
    fs.appendFileSync(logFile, logLine + '\n', 'utf-8');
  } catch (err) {
    // 静默失败
  }
}

// ---------- 内存管理模块（可选加载） ----------
let memoryManager = null;
let useCache = false;

try {
  memoryManager = require('./memorycache');
  useCache = true;
  log(LOG_LEVELS.INFO, 'memoryManager 已加载');
} catch (err) {
  log(LOG_LEVELS.WARN, 'memoryManager 未加载，将禁用内存缓存（所有请求实时读取硬盘）');
}

const app = express();

// ============================================================
// 导入并启动管理服务（独立端口）
// ============================================================
const { createAdminServer } = require('./adminserver');

try {
  createAdminServer();
} catch (err) {
  log(LOG_LEVELS.WARN, '管理服务启动失败，不影响博客主页运行: %s', err.message);
}

// ---------- 固定路径 ----------
const PROJECT_ROOT = __dirname;
const CONTENT_DIR = path.join(PROJECT_ROOT, 'content');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'config.json');
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
const MEMORY_CACHE_PATH = path.join(PROJECT_ROOT, 'memorycache.json');

log(LOG_LEVELS.DEBUG, '项目根目录: %s', PROJECT_ROOT);
log(LOG_LEVELS.DEBUG, '内容目录: %s', CONTENT_DIR);
log(LOG_LEVELS.DEBUG, '配置文件: %s', CONFIG_PATH);
log(LOG_LEVELS.DEBUG, '静态资源目录: %s', PUBLIC_DIR);
log(LOG_LEVELS.DEBUG, '内存配置文件: %s', MEMORY_CACHE_PATH);
log(LOG_LEVELS.DEBUG, '日志目录: %s', LOG_DIR);

// ---------- 缓存数据结构 ----------
let cache = {
  config: null,
  home: '',
  about: '',
  posts: [],
  moments: []
};

// ---------- 确保 memorycache.json 存在 ----------
function ensureMemoryCacheFile() {
  if (!fs.existsSync(MEMORY_CACHE_PATH)) {
    const defaultConfig = { enable: 'auto', maxMemoryMB: 50 };
    try {
      fs.writeFileSync(MEMORY_CACHE_PATH, JSON.stringify(defaultConfig, null, 2), 'utf-8');
      log(LOG_LEVELS.INFO, 'memorycache.json 已自动创建（默认配置: enable=auto, maxMemoryMB=50）');
    } catch (err) {
      log(LOG_LEVELS.ERROR, '无法创建 memorycache.json: %s', err.message);
      process.exit(1);
    }
  } else {
    log(LOG_LEVELS.DEBUG, 'memorycache.json 已存在');
  }
}
ensureMemoryCacheFile();

// ---------- 安全的 HTML 清理 ----------
function cleanHtml(dirtyHtml) {
  return dirtyHtml
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/on\w+\s*=/gi, 'data-removed-');
}

// ---------- 读取 Markdown 文件 ----------
function readMd(relativePath) {
  const fullPath = path.join(CONTENT_DIR, relativePath);
  if (fs.existsSync(fullPath)) {
    const raw = fs.readFileSync(fullPath, 'utf-8');
    log(LOG_LEVELS.DEBUG, '读取 MD 文件: %s (%d 字符)', relativePath, raw.length);
    return cleanHtml(marked.parse(raw));
  }
  log(LOG_LEVELS.WARN, 'MD 文件不存在: %s，返回占位内容', relativePath);
  return '<p>📭 暂无内容，写点什么吧。</p>';
}

function readMdDir(relativeDir) {
  const fullDir = path.join(CONTENT_DIR, relativeDir);
  if (!fs.existsSync(fullDir)) {
    log(LOG_LEVELS.DEBUG, '目录不存在: %s，返回空数组', relativeDir);
    return [];
  }
  const files = fs.readdirSync(fullDir).filter(f => f.endsWith('.md'));
  log(LOG_LEVELS.DEBUG, '读取目录: %s，找到 %d 个 MD 文件', relativeDir, files.length);
  return files.map(f => {
    const raw = fs.readFileSync(path.join(fullDir, f), 'utf-8');
    return {
      id: f.replace('.md', ''),
      html: cleanHtml(marked.parse(raw))
    };
  }).reverse();
}

// ---------- 核心加载函数 ----------
function loadContent() {
  log(LOG_LEVELS.INFO, '开始加载内容...');
  try {
    const configRaw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const config = JSON.parse(configRaw);
    log(LOG_LEVELS.DEBUG, 'config.json 解析成功');

    cache.config = config;
    cache.home = readMd(config.sources?.home || 'home.md');
    cache.about = readMd(config.sources?.about || 'about.md');

    if (useCache && memoryManager) {
      log(LOG_LEVELS.INFO, '内存缓存已启用，正在加载文章和动态...');
      const postsData = readMdDir(config.sources?.posts || 'posts');
      const momentsData = readMdDir(config.sources?.moments || 'moments');
      cache.posts = postsData;
      cache.moments = momentsData;
      log(LOG_LEVELS.DEBUG, '文章数: %d，动态数: %d', postsData.length, momentsData.length);

      const decision = memoryManager.getCacheDecision();
      log(LOG_LEVELS.DEBUG, '内存策略决策: useCache=%s, limitMB=%s, reason=%s',
        decision.useCache, decision.limitMB, decision.reason);

      if (!decision.useCache) {
        log(LOG_LEVELS.WARN, '内存策略：%s', decision.reason);
        cache.posts = [];
        cache.moments = [];
      } else {
        const currentSize = memoryManager.calculateCacheSize(cache);
        log(LOG_LEVELS.DEBUG, '当前缓存数据大小: %.2fMB，上限: %.2fMB', currentSize, decision.limitMB);
        if (currentSize > decision.limitMB) {
          log(LOG_LEVELS.WARN, '缓存数据 %.2fMB 超过上限 %.2fMB，清空文章/动态缓存', currentSize, decision.limitMB);
          cache.posts = [];
          cache.moments = [];
        } else {
          log(LOG_LEVELS.INFO, '✅ 缓存已启用（%s），当前数据 %.2fMB', decision.reason, currentSize);
        }
      }
    } else {
      cache.posts = [];
      cache.moments = [];
      log(LOG_LEVELS.INFO, '⛔ 内存缓存已禁用（memoryManager 缺失或策略关闭）');
    }

    log(LOG_LEVELS.INFO, '✅ 缓存已更新 [%s]', new Date().toLocaleTimeString());
  } catch (err) {
    log(LOG_LEVELS.ERROR, '加载失败: %s', err.message);
    log(LOG_LEVELS.DEBUG, err.stack);
  }
}

// 初次加载
loadContent();

// ---------- 热更新监听（文件变化） ----------
log(LOG_LEVELS.INFO, '启动热更新监听...');
chokidar.watch([CONTENT_DIR, CONFIG_PATH, MEMORY_CACHE_PATH], { ignoreInitial: true })
  .on('all', (event, filePath) => {
    log(LOG_LEVELS.INFO, '检测到变化: %s (事件: %s)', path.basename(filePath), event);
    loadContent();
  });

// ---------- 定时内存检查 ----------
const MEMORY_CHECK_INTERVAL = 30 * 1000;
log(LOG_LEVELS.INFO, '启动定时内存检查 (间隔: %d 秒)', MEMORY_CHECK_INTERVAL / 1000);
setInterval(() => {
  if (useCache && memoryManager) {
    log(LOG_LEVELS.DEBUG, '⏰ 定时内存检查触发');
    loadContent();
  }
}, MEMORY_CHECK_INTERVAL);

// ---------- API ----------
app.get('/api/data', (req, res) => {
  const clientIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  log(LOG_LEVELS.DEBUG, 'API 请求 /api/data 来自 %s', clientIP);

  if (cache.posts.length > 0 || cache.moments.length > 0) {
    log(LOG_LEVELS.DEBUG, '返回缓存数据 (文章: %d, 动态: %d)', cache.posts.length, cache.moments.length);
    return res.json(cache);
  }

  log(LOG_LEVELS.INFO, '缓存为空，实时读取硬盘数据');
  try {
    const configRaw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const config = JSON.parse(configRaw);
    log(LOG_LEVELS.DEBUG, '实时读取 config.json 成功');

    const data = {
      config: cache.config || config,
      home: cache.home || readMd(config.sources?.home || 'home.md'),
      about: cache.about || readMd(config.sources?.about || 'about.md'),
      posts: readMdDir(config.sources?.posts || 'posts'),
      moments: readMdDir(config.sources?.moments || 'moments')
    };
    log(LOG_LEVELS.DEBUG, '实时读取完成 (文章: %d, 动态: %d)', data.posts.length, data.moments.length);
    res.json(data);
  } catch (err) {
    log(LOG_LEVELS.ERROR, '实时读取失败: %s', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- 静态资源 ----------
app.use(express.static(PUBLIC_DIR));
log(LOG_LEVELS.DEBUG, '静态资源托管: %s', PUBLIC_DIR);

// ---------- 启动服务 ----------
function startServer() {
  log(LOG_LEVELS.INFO, '正在启动服务器...');

  if (!cache.config) {
    log(LOG_LEVELS.ERROR, '无法启动：config.json 未加载或解析失败');
    process.exit(1);
  }

  const PORT = cache.config.port;
  if (PORT === undefined || PORT === null) {
    log(LOG_LEVELS.ERROR, '无法启动：config.json 中缺少 "port" 字段');
    console.error('   请在 config.json 中添加类似 "port": 3000 的配置');
    process.exit(1);
  }

  if (typeof PORT !== 'number' || !Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    log(LOG_LEVELS.ERROR, '无法启动：config.json 中的 "port" 值无效 (%s)', PORT);
    console.error('   端口号必须是 1-65535 之间的整数');
    process.exit(1);
  }

  app.listen(PORT, '0.0.0.0', () => {
    log(LOG_LEVELS.INFO, '🚀 博客主页已启动: http://localhost:%d', PORT);
    log(LOG_LEVELS.INFO, '📁 内容目录: %s', CONTENT_DIR);
    log(LOG_LEVELS.INFO, '🖼️  静态资源: %s', PUBLIC_DIR);
    log(LOG_LEVELS.INFO, '🧠 内存配置: %s', MEMORY_CACHE_PATH);
    log(LOG_LEVELS.INFO, '🌐 监听地址: 0.0.0.0:%d', PORT);
    log(LOG_LEVELS.INFO, '📄 日志目录: %s', LOG_DIR);
    log(LOG_LEVELS.INFO, '⏰ 定时内存检查间隔: %d 秒', MEMORY_CHECK_INTERVAL / 1000);
  });
}

startServer();