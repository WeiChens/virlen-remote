import { defineConfig } from 'vitest/config'

/**
 * 协议栈共享包的单测配置。
 *
 * 刻意用 **node** 环境：协议层（帧/RPC/幂等/重放）不含任何 DOM 依赖。
 * （WebRTC transport 属 M3，不在本包的单测范围内——本包只覆盖 memory transport。）
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
