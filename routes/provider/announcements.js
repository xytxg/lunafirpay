/**
 * Provider 公告管理路由
 */
const express = require('express');
const router = express.Router();
const db = require('../../config/database');
const { requireProviderRamPermission } = require('../auth');

// 公告列表（管理员）
router.get('/announcements', requireProviderRamPermission('settings'), async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 20, 1), 100);
    const offset = (page - 1) * pageSize;

    const where = [];
    const params = [];

    if (req.query.keyword) {
      where.push('(title LIKE ? OR content LIKE ?)');
      params.push(`%${req.query.keyword}%`, `%${req.query.keyword}%`);
    }

    if (req.query.enabled === '0' || req.query.enabled === '1') {
      where.push('is_enabled = ?');
      params.push(parseInt(req.query.enabled, 10));
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const [[countRow]] = await db.query(
      `SELECT COUNT(*) AS total FROM merchant_announcements ${whereSql}`,
      params
    );

    const [rows] = await db.query(
      `SELECT id, title, content, sort_order, is_enabled, created_at, updated_at
       FROM merchant_announcements
       ${whereSql}
       ORDER BY sort_order DESC, id DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    res.json({
      code: 0,
      data: {
        list: rows,
        total: countRow.total,
        page,
        pageSize
      }
    });
  } catch (error) {
    console.error('获取公告列表失败:', error);
    res.json({ code: -1, msg: '获取公告列表失败' });
  }
});

// 创建公告（管理员）
router.post('/announcements', requireProviderRamPermission('settings'), async (req, res) => {
  try {
    const title = String(req.body.title || '').trim();
    const content = String(req.body.content || '').trim();
    const sortOrder = Number.isFinite(Number(req.body.sort_order)) ? parseInt(req.body.sort_order, 10) : 0;
    const isEnabled = req.body.is_enabled === 0 || req.body.is_enabled === '0' ? 0 : 1;

    if (!title) {
      return res.json({ code: -1, msg: '公告标题不能为空' });
    }
    if (!content) {
      return res.json({ code: -1, msg: '公告内容不能为空' });
    }

    const [result] = await db.query(
      'INSERT INTO merchant_announcements (title, content, sort_order, is_enabled) VALUES (?, ?, ?, ?)',
      [title, content, sortOrder, isEnabled]
    );

    res.json({ code: 0, msg: '创建成功', data: { id: result.insertId } });
  } catch (error) {
    console.error('创建公告失败:', error);
    res.json({ code: -1, msg: '创建公告失败' });
  }
});

// 更新公告（管理员）
router.put('/announcements/:id', requireProviderRamPermission('settings'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) {
      return res.json({ code: -1, msg: '参数错误' });
    }

    const title = req.body.title !== undefined ? String(req.body.title).trim() : undefined;
    const content = req.body.content !== undefined ? String(req.body.content).trim() : undefined;
    const sortOrder = req.body.sort_order !== undefined ? parseInt(req.body.sort_order, 10) : undefined;
    const isEnabled = req.body.is_enabled !== undefined
      ? (req.body.is_enabled === 0 || req.body.is_enabled === '0' ? 0 : 1)
      : undefined;

    const sets = [];
    const params = [];

    if (title !== undefined) {
      if (!title) return res.json({ code: -1, msg: '公告标题不能为空' });
      sets.push('title = ?');
      params.push(title);
    }

    if (content !== undefined) {
      if (!content) return res.json({ code: -1, msg: '公告内容不能为空' });
      sets.push('content = ?');
      params.push(content);
    }

    if (sortOrder !== undefined && !Number.isNaN(sortOrder)) {
      sets.push('sort_order = ?');
      params.push(sortOrder);
    }

    if (isEnabled !== undefined) {
      sets.push('is_enabled = ?');
      params.push(isEnabled);
    }

    if (sets.length === 0) {
      return res.json({ code: -1, msg: '没有可更新的字段' });
    }

    params.push(id);
    const [result] = await db.query(
      `UPDATE merchant_announcements SET ${sets.join(', ')} WHERE id = ?`,
      params
    );

    if (result.affectedRows === 0) {
      return res.json({ code: -1, msg: '公告不存在' });
    }

    res.json({ code: 0, msg: '更新成功' });
  } catch (error) {
    console.error('更新公告失败:', error);
    res.json({ code: -1, msg: '更新公告失败' });
  }
});

// 调整公告优先级（管理员）
router.post('/announcements/:id/move', requireProviderRamPermission('settings'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const action = String(req.body.action || '').toLowerCase();

    if (!id || !['up', 'down'].includes(action)) {
      return res.json({ code: -1, msg: '参数错误' });
    }

    const [[row]] = await db.query(
      'SELECT id, sort_order FROM merchant_announcements WHERE id = ? LIMIT 1',
      [id]
    );

    if (!row) {
      return res.json({ code: -1, msg: '公告不存在' });
    }

    const delta = action === 'up' ? 1 : -1;
    await db.query(
      'UPDATE merchant_announcements SET sort_order = sort_order + ? WHERE id = ?',
      [delta, id]
    );

    res.json({ code: 0, msg: '优先级已更新' });
  } catch (error) {
    console.error('调整公告优先级失败:', error);
    res.json({ code: -1, msg: '调整公告优先级失败' });
  }
});

// 删除公告（管理员）
router.delete('/announcements/:id', requireProviderRamPermission('settings'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) {
      return res.json({ code: -1, msg: '参数错误' });
    }

    const [result] = await db.query('DELETE FROM merchant_announcements WHERE id = ?', [id]);
    if (result.affectedRows === 0) {
      return res.json({ code: -1, msg: '公告不存在' });
    }

    res.json({ code: 0, msg: '删除成功' });
  } catch (error) {
    console.error('删除公告失败:', error);
    res.json({ code: -1, msg: '删除公告失败' });
  }
});

module.exports = router;
