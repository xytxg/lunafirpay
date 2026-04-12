/**
 * Provider 系统配置路由
 */
const express = require('express');
const router = express.Router();
const systemConfig = require('../../utils/systemConfig');
const { syncSitePublicConfigFromSystem } = require('../../utils/sitePublicConfig');
const { requireProviderRamPermission } = require('../auth');

// 获取系统配置（支付设置相关）
router.get('/system/config', requireProviderRamPermission('settings'), async (req, res) => {
  try {
    const allConfig = await systemConfig.getAllConfig();
    
    // 只返回需要的配置项
    const paymentConfig = {
      order_name_template: allConfig.order_name_template || '',
      page_order_name: allConfig.page_order_name || '0',
      notify_order_name: allConfig.notify_order_name || '0',
      site_name: allConfig.site_name || '支付平台',
      api_endpoint: allConfig.api_endpoint || '',
      domain_whitelist_enabled: allConfig.domain_whitelist_enabled || '0',
      direct_pay_feature_enabled: allConfig.direct_pay_feature_enabled || '1',
      user_refund: allConfig.user_refund || '0',
      auto_approve_merchant: allConfig.auto_approve_merchant || '0',
      test_pay_enabled: allConfig.test_pay_enabled || '0',
      test_pay_group_id: allConfig.test_pay_group_id || '',
      test_pay_max_amount: allConfig.test_pay_max_amount || '50000',
      test_pay_auto_refund: allConfig.test_pay_auto_refund || '0'
    };
    
    res.json({ code: 0, data: paymentConfig });
  } catch (error) {
    console.error('获取系统配置失败:', error);
    res.json({ code: -1, msg: '获取系统配置失败' });
  }
});

// 更新系统配置
router.post('/system/config', requireProviderRamPermission('settings'), async (req, res) => {
  try {
    const {
      order_name_template,
      page_order_name,
      notify_order_name,
      site_name,
      api_endpoint,
      domain_whitelist_enabled,
      direct_pay_feature_enabled,
      user_refund,
      auto_approve_merchant,
      test_pay_enabled,
      test_pay_group_id,
      test_pay_max_amount,
      test_pay_auto_refund
    } = req.body;
    
    // 更新配置
    if (order_name_template !== undefined) {
      await systemConfig.setConfig('order_name_template', order_name_template, '订单名称模板');
    }
    if (page_order_name !== undefined) {
      await systemConfig.setConfig('page_order_name', page_order_name, '收银台隐藏商品名');
    }
    if (notify_order_name !== undefined) {
      await systemConfig.setConfig('notify_order_name', notify_order_name, '回调通知隐藏商品名');
    }
    if (site_name !== undefined) {
      await systemConfig.setConfig('site_name', site_name, '站点名称');
    }
    if (api_endpoint !== undefined) {
      await systemConfig.setConfig('api_endpoint', api_endpoint, 'API端点地址');
    }
    if (domain_whitelist_enabled !== undefined) {
      await systemConfig.setConfig('domain_whitelist_enabled', domain_whitelist_enabled, '启用域名白名单验证');
    }
    if (direct_pay_feature_enabled !== undefined) {
      await systemConfig.setConfig('direct_pay_feature_enabled', String(direct_pay_feature_enabled), '直接收款功能开关(0=关闭,1=开启)');
    }
    if (user_refund !== undefined) {
      await systemConfig.setConfig('user_refund', user_refund, '商户自助退款(0=关闭,1=开启)');
    }
    if (auto_approve_merchant !== undefined) {
      await systemConfig.setConfig('auto_approve_merchant', auto_approve_merchant, '注册商户自动开通(0=需审核,1=自动开通)');
    }
    if (test_pay_enabled !== undefined) {
      await systemConfig.setConfig('test_pay_enabled', test_pay_enabled, '测试支付开关(0=关闭,1=开启)');
    }
    if (test_pay_group_id !== undefined) {
      await systemConfig.setConfig('test_pay_group_id', String(test_pay_group_id || ''), '测试支付使用的支付组ID');
    }
    if (test_pay_max_amount !== undefined) {
      await systemConfig.setConfig('test_pay_max_amount', String(test_pay_max_amount || '50000'), '测试支付最大可输入金额');
    }
    if (test_pay_auto_refund !== undefined) {
      await systemConfig.setConfig('test_pay_auto_refund', String(test_pay_auto_refund || '0'), '测试支付成功后自动秒退(0=否,1=是)');
    }

    // 同步前台站点配置文件（dist/site-config.json）
    try {
      await syncSitePublicConfigFromSystem(systemConfig);
    } catch (syncError) {
      console.error('同步站点配置文件失败:', syncError);
    }
    
    res.json({ code: 0, msg: '保存成功' });
  } catch (error) {
    console.error('保存系统配置失败:', error);
    res.json({ code: -1, msg: '保存系统配置失败' });
  }
});

module.exports = router;
