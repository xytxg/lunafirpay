const fs = require('fs').promises;
const path = require('path');

const SITE_CONFIG_PATH = path.join(__dirname, '..', 'dist', 'site-config.json');

const DEFAULT_SITE_CONFIG = {
  siteName: '支付平台'
};

function normalizeSitePublicConfig(config = {}) {
  const siteNameRaw = typeof config.siteName === 'string' ? config.siteName.trim() : '';

  return {
    siteName: siteNameRaw || DEFAULT_SITE_CONFIG.siteName
  };
}

function isValidSitePublicConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return false;
  }

  const siteNameOk = typeof config.siteName === 'string' && config.siteName.trim().length > 0;
  return siteNameOk;
}

async function writeSitePublicConfig(config = {}) {
  const payload = normalizeSitePublicConfig({
    ...DEFAULT_SITE_CONFIG,
    ...(config || {})
  });
  const nextText = JSON.stringify(payload, null, 2);

  await fs.mkdir(path.dirname(SITE_CONFIG_PATH), { recursive: true });

  try {
    const currentText = await fs.readFile(SITE_CONFIG_PATH, 'utf8');
    if ((currentText || '').trim() === nextText.trim()) {
      return payload;
    }
  } catch (error) {
    // 文件不存在时继续写入
  }

  await fs.writeFile(SITE_CONFIG_PATH, nextText, 'utf8');
  return payload;
}

async function ensureSitePublicConfigFile() {
  try {
    const text = await fs.readFile(SITE_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(text);

    if (!isValidSitePublicConfig(parsed)) {
      const rebuilt = await writeSitePublicConfig(parsed);
      return { created: true, repaired: true, config: rebuilt };
    }

    const normalized = normalizeSitePublicConfig(parsed);
    const changed =
      normalized.siteName !== parsed.siteName ||
      Object.keys(parsed).some((key) => key !== 'siteName');

    if (changed) {
      await fs.writeFile(SITE_CONFIG_PATH, JSON.stringify(normalized, null, 2), 'utf8');
    }

    return { created: false, repaired: false, config: normalized };
  } catch (error) {
    // 不存在、JSON损坏、读取失败都按“重建”处理
    const rebuilt = await writeSitePublicConfig(DEFAULT_SITE_CONFIG);
    return { created: true, repaired: true, config: rebuilt };
  }
}

async function syncSitePublicConfigFromSystem(systemConfigService) {
  const siteName = await systemConfigService.getSiteName();

  return writeSitePublicConfig({
    siteName
  });
}

module.exports = {
  SITE_CONFIG_PATH,
  DEFAULT_SITE_CONFIG,
  normalizeSitePublicConfig,
  isValidSitePublicConfig,
  writeSitePublicConfig,
  ensureSitePublicConfigFile,
  syncSitePublicConfigFromSystem
};
