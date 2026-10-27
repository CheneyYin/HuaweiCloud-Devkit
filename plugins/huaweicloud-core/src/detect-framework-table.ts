// The frameworks spec table of the detect-framework family: per-framework
// detection specs (type, commands, output dir, port, nginx shape) as pure
// data — no filesystem access, no logic. The matching chain
// (detect-framework-match.ts) maps a project onto one of these specs; the
// scan orchestration (detect-framework-scan.ts) builds the public result.
// The public face stays src/detect-framework.ts.

export interface FrameworkSpec {
  type: string;
  framework: string;
  installCmd: string | null;
  buildCmd: string | null;
  outputDir: string | null;
  port: number;
  serveCmd: string | null;
  checkUrl: string;
  nginxType: string;
}

// `satisfies` (not a Record annotation) keeps the literal key set, so the
// FRAMEWORKS.<name> lookups below stay total under noUncheckedIndexedAccess.
export const FRAMEWORKS = {
  nextjs: {
    type: 'ssr',
    framework: 'Next.js',
    installCmd: 'npm install',
    buildCmd: 'npm run build',
    outputDir: '.next',
    port: 3000,
    serveCmd: 'nohup npm start > /tmp/app.log 2>&1 &',
    checkUrl: 'http://localhost:3000',
    nginxType: 'proxy',
  },
  nuxt: {
    type: 'ssr',
    framework: 'Nuxt',
    installCmd: 'npm install',
    buildCmd: 'npm run build',
    outputDir: '.output',
    port: 3000,
    serveCmd: 'nohup node .output/server/index.mjs > /tmp/app.log 2>&1 &',
    checkUrl: 'http://localhost:3000',
    nginxType: 'proxy',
  },
  vitepress: {
    type: 'ssg',
    framework: 'VitePress',
    installCmd: 'npm install',
    buildCmd: 'npm run docs:build',
    outputDir: '.vitepress/dist',
    port: 8080,
    serveCmd: null,
    checkUrl: 'http://localhost:8080',
    nginxType: 'spa',
  },
  docusaurus: {
    type: 'ssg',
    framework: 'Docusaurus',
    installCmd: 'npm install',
    buildCmd: 'npm run build',
    outputDir: 'build',
    port: 8080,
    serveCmd: null,
    checkUrl: 'http://localhost:8080',
    nginxType: 'spa',
  },
  hugo: {
    type: 'ssg',
    framework: 'Hugo',
    installCmd: null,
    buildCmd: 'hugo',
    outputDir: 'public',
    port: 8080,
    serveCmd: null,
    checkUrl: 'http://localhost:8080',
    nginxType: 'static',
  },
  hexo: {
    type: 'ssg',
    framework: 'Hexo',
    installCmd: 'npm install',
    buildCmd: 'npm run build',
    outputDir: 'public',
    port: 8080,
    serveCmd: null,
    checkUrl: 'http://localhost:8080',
    nginxType: 'static',
  },
  taro: {
    type: 'cross-platform',
    framework: 'Taro',
    installCmd: 'npm install',
    buildCmd: 'npm run build:h5',
    outputDir: 'dist',
    port: 8080,
    serveCmd: null,
    checkUrl: 'http://localhost:8080',
    nginxType: 'spa',
  },
  uniapp: {
    type: 'cross-platform',
    framework: 'uni-app',
    installCmd: 'npm install',
    buildCmd: 'npm run build:h5',
    outputDir: 'dist/build/h5',
    port: 8080,
    serveCmd: null,
    checkUrl: 'http://localhost:8080',
    nginxType: 'spa',
  },
  angular: {
    type: 'spa',
    framework: 'Angular',
    installCmd: 'npm install',
    buildCmd: 'npm run build',
    outputDir: null,
    port: 8080,
    serveCmd: null,
    checkUrl: 'http://localhost:8080',
    nginxType: 'spa',
  },
  vite: {
    type: 'spa',
    framework: 'Vite (React/Vue/Svelte)',
    installCmd: 'npm install',
    buildCmd: 'npm run build',
    outputDir: 'dist',
    port: 8080,
    serveCmd: null,
    checkUrl: 'http://localhost:8080',
    nginxType: 'spa',
  },
  cra: {
    type: 'spa',
    framework: 'Create React App',
    installCmd: 'npm install',
    buildCmd: 'npm run build',
    outputDir: 'build',
    port: 8080,
    serveCmd: null,
    checkUrl: 'http://localhost:8080',
    nginxType: 'spa',
  },
  vueCli: {
    type: 'spa',
    framework: 'Vue CLI',
    installCmd: 'npm install',
    buildCmd: 'npm run build',
    outputDir: 'dist',
    port: 8080,
    serveCmd: null,
    checkUrl: 'http://localhost:8080',
    nginxType: 'spa',
  },
  static: {
    type: 'static',
    framework: 'Static Site',
    installCmd: null,
    buildCmd: null,
    outputDir: '.',
    port: 8080,
    serveCmd: null,
    checkUrl: 'http://localhost:8080',
    nginxType: 'static',
  },
} satisfies Record<string, FrameworkSpec>;
