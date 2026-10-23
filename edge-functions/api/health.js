/**
 * EdgeOne Pages Functions 路由：/api/health
 */

import { handleHealthRequest } from '../../src/server/api/health.js';

export async function onRequest(context) {
  return handleHealthRequest(context);
}
