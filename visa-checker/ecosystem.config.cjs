module.exports = {
  apps: [
    {
      name: 'visa-checker',
      script: 'checker.js',
      cwd: __dirname,
      watch: false,
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
}
