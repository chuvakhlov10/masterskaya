import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // base path для GitHub Pages — нужно чтобы файлы находились по правильному пути
  base: './',
})
