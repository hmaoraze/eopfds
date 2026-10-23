/**
 * EdgeOne Pages Functions 路由：/api/wechat
 * 统一会话接口：创建 / 续接 / 显式结束 / 超时回收 / iLink 原生接入
 */

import { handleWechatRequest } from '../../src/server/api/wechat.js';

export async function onRequest(context) {
  return handleWechatRequest(context);
}
