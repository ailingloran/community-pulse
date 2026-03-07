module.exports = {
  apps: [
    {
      name: 'community-pulse',
      script: 'dist/index.js',
      cwd: '/home/kuba/community-pulse',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
