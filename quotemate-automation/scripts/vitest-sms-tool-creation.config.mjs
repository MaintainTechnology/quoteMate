import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const appDirectory = fileURLToPath(new URL('../', import.meta.url))
export default defineConfig({
  root: appDirectory,
  test: { environment: 'node', include: ['tests/sms-tool-creation.test.mjs', 'tests/sms-tool-save-sql.test.mjs'], maxWorkers: 1 },
  resolve: { alias: { '@': appDirectory } },
})
