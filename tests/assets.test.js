const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

describe('离线 OCR 发布资产', () => {
  test.each([
    'vendor/tesseract/tesseract.min.js',
    'vendor/tesseract/worker.min.js',
    'vendor/tesseract/core/tesseract-core.wasm.js',
    'vendor/tesseract/core/tesseract-core-simd.wasm.js',
    'vendor/tesseract/core/tesseract-core-lstm.wasm.js',
    'vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js',
    'vendor/tesseract/lang/chi_sim.traineddata.gz',
  ])('%s 已打包且非空', (relativePath) => {
    const file = path.join(root, relativePath);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).size).toBeGreaterThan(0);
  });
});
