/**
 * EdgeOne Pages Functions 路由：/api/admin
 * 管理端 JSON API（配置项 + Passkey + 安全链接 + 运维）
 */

import { handleAdminRequest } from '../../src/server/api/admin.js';

export async function onRequest(context) {
  return handleAdminRequest(context);
}
