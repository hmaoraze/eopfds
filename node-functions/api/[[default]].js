/**
 * EdgeOne Makers Node Functions 入口（catch-all）。
 *
 * 部署路径：node-functions/api/[[default]].js → 接管 /api/*
 * 平台按文件路径生成路由，`[[default]]` 匹配该目录下任意层级，
 * 因此 /api/session/create、/api/admin/config/status 都会进到这里，由 src/router.js 分发。
 *
 * 为什么用 Node Functions 而不是 Edge Functions（edge-functions/）：
 * Blob 目前只提供 Node.js SDK（@edgeone/pages-blob），官方文档写明「其他运行时的 SDK 正在开发中」，
 * 放进 Edge Functions 会直接 import 失败。
 *
 * 本文件不含业务逻辑，整条链可在 Node 里用伪造的 context 直接跑测试。
 */

import { handleRequest } from '../../src/router.js';

export default function onRequest(context) {
  return handleRequest(context);
}
