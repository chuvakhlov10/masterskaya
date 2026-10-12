import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

function offlineShell() {
  let outDir;
  return {
    name:'versioned-offline-shell', apply:'build',
    configResolved(config) { outDir=resolve(config.root, config.build.outDir); },
    closeBundle() {
      const assets=readdirSync(resolve(outDir, 'assets')).filter(file => /\.(js|css)$/.test(file)).sort();
      const html=readFileSync(resolve(outDir,'index.html'),'utf8');
      const version=createHash('sha256').update(html).digest('hex').slice(0,16);
      const shell=['./index.html', ...assets.map(file=>'./assets/'+file)];
      const path=resolve(outDir,'sw.js');
      const worker=readFileSync(path,'utf8')
        .replace("'masterskaya-shell-dev'", JSON.stringify('masterskaya-shell-'+version))
        .replace("const BUILD_ASSETS = ['./index.html'];", 'const BUILD_ASSETS = '+JSON.stringify(shell)+';');
      writeFileSync(path,worker);
    },
  };
}

export default defineConfig({
  plugins: [react(), offlineShell()],
  // base path для GitHub Pages — нужно чтобы файлы находились по правильному пути
  base: './',
})
