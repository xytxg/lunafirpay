/**
 * 商户公告路由
 */
const express = require('express');
const router = express.Router();
const db = require('../../config/database');

// 商户端公告列表（仅展示启用公告）
router.get('/announcements', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);

    const [rows] = await db.query(
      `SELECT id, title, content, sort_order, created_at
       FROM merchant_announcements
       WHERE is_enabled = 1
       ORDER BY sort_order DESC, id DESC
       LIMIT ?`,
      [limit]
    );

    res.json({ code: 0, data: rows });
  } catch (error) {
    console.error('获取商户公告失败:', error);
    res.json({ code: -1, msg: '获取公告失败' });
  }
});

module.exports = router;
