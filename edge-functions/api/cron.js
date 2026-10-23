/**
 * EdgeOne Pages Functions 路由：/api/cron
 * 定时回收 / 单次轮询拉消息 / 摘要刷新
 */

import { handleCronRequest } from '../../src/server/api/cron.js';

export async function onRequest(context) {
  return handleCronRequest(context);
}
