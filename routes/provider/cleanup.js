/**
 * Provider 清理记录与定时清理路由
 */
const express = require('express');
const router = express.Router();
const db = require('../../config/database');
const recordCleanupService = require('../../utils/recordCleanupService');
const { requireProviderRamPermission } = require('../auth');

function logCleanupRequest(tag, payload) {
  try {
    const safePayload = {
      ...(payload || {}),
      merchant_ids: Array.isArray(payload?.merchant_ids)
        ? payload.merchant_ids.slice(0, 20)
        : payload?.merchant_ids
    };
    console.log(`[Cleanup][${tag}] request:`, JSON.stringify(safePayload));
  } catch (e) {
    console.log(`[Cleanup][${tag}] request log failed:`, e.message);
  }
}

function logCleanupResponse(tag, result) {
  try {
    const summary = {
      code: result?.code,
      msg: result?.msg,
      merchant_scope: result?.data?.merchant_scope,
      merchant_count: result?.data?.merchant_count,
      preview: result?.data?.preview,
      ordersAffected: result?.data?.ordersAffected,
      directLinksAffected: result?.data?.directLinksAffected,
      settlementsAffected: result?.data?.settlementsAffected,
      totalAffected: result?.data?.totalAffected
    };
    console.log(`[Cleanup][${tag}] response:`, JSON.stringify(summary));
  } catch (e) {
    console.log(`[Cleanup][${tag}] response log failed:`, e.message);
  }
}

// 商户列表（用于清理页面选择，分页20）
router.get('/cleanup/merchants', requireProviderRamPermission('finance', 'order', 'settings'), async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const pageSize = Math.max(parseInt(req.query.pageSize || '20', 10), 1);
    const keyword = String(req.query.keyword || '').trim();

    let whereSql = 'WHERE u.is_admin = 0';
    const params = [];

    if (keyword) {
      whereSql += ' AND CAST(m.id AS CHAR) LIKE ?';
      const like = `%${keyword}%`;
      params.push(like);
    }

    const [countRows] = await db.query(
      `SELECT COUNT(*) AS total
       FROM merchants m
       JOIN users u ON m.user_id = u.id
       ${whereSql}`,
      params
    );

    const [rows] = await db.query(
      `SELECT m.id AS merchant_no, m.user_id, COALESCE(m.name, u.username) AS merchant_name, m.status, u.username
       FROM merchants m
       JOIN users u ON m.user_id = u.id
       ${whereSql}
       ORDER BY m.id DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize]
    );

    res.json({
      code: 0,
      data: {
        list: rows,
        total: Number(countRows[0]?.total || 0),
        page,
        pageSize
      }
    });
  } catch (error) {
    console.error('获取清理商户列表失败:', error);
    res.json({ code: -1, msg: '获取清理商户列表失败' });
  }
});

// 获取定时清理配置
router.get('/cleanup/config', requireProviderRamPermission('finance', 'order', 'settings'), async (req, res) => {
  try {
    const config = await recordCleanupService.getConfig();
    res.json({ code: 0, data: config });
  } catch (error) {
    console.error('获取清理配置失败:', error);
    res.json({ code: -1, msg: '获取清理配置失败' });
  }
});

// 保存定时清理配置
router.post('/cleanup/config', requireProviderRamPermission('finance', 'order', 'settings'), async (req, res) => {
  try {
    const config = await recordCleanupService.saveConfig(req.body || {});
    res.json({ code: 0, msg: '保存成功', data: config });
  } catch (error) {
    console.error('保存清理配置失败:', error);
    res.json({ code: -1, msg: '保存清理配置失败' });
  }
});

// 预览清理数量
router.post('/cleanup/preview', requireProviderRamPermission('finance', 'order', 'settings'), async (req, res) => {
  try {
    logCleanupRequest('preview', req.body || {});
    const preview = await recordCleanupService.preview(req.body || {});
    logCleanupResponse('preview', preview);
    if (preview.code !== 0) {
      return res.json(preview);
    }
    return res.json(preview);
  } catch (error) {
    console.error('预览清理失败:', error);
    res.json({ code: -1, msg: '预览清理失败' });
  }
});

// 立即执行清理
router.post('/cleanup/run', requireProviderRamPermission('finance', 'order', 'settings'), async (req, res) => {
  try {
    const operatorId = req.user?.user_id ? String(req.user.user_id) : 'system';
    logCleanupRequest('run', { ...(req.body || {}), operator_id: operatorId });
    const result = await recordCleanupService.runCleanup({
      ...req.body,
      trigger_type: 'manual',
      operator_id: operatorId
    });
    logCleanupResponse('run', result);
    res.json(result);
  } catch (error) {
    console.error('执行清理失败:', error);
    res.json({ code: -1, msg: '执行清理失败' });
  }
});

// 清理日志
router.get('/cleanup/logs', requireProviderRamPermission('finance', 'order', 'settings'), async (req, res) => {
  try {
    const data = await recordCleanupService.listLogs(1, 3);
    res.json({ code: 0, data });
  } catch (error) {
    console.error('获取清理日志失败:', error);
    res.json({ code: -1, msg: '获取清理日志失败' });
  }
});

module.exports = router;
