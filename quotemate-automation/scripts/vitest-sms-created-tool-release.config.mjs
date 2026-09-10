import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
const appDirectory = fileURLToPath(new URL('../', import.meta.url))
export default defineConfig({ root: appDirectory,
  test: { environment: 'node', include: ['tests/sms-created-tool-release.test.mjs'], maxWorkers: 1 },
  resolve: { alias: { '@': appDirectory } },
})
