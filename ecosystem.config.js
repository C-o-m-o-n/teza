// PM2 Ecosystem Config — TEZA production server
module.exports = {
  apps: [
    {
      name: 'teza',
      script: 'server/server.js',
      cwd: __dirname,

      // Single instance — WebSocket state is in-memory
      instances: 1,
      exec_mode: 'fork',

      // Never restart on deliberate stop; auto-restart on crash
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',

      // Graceful shutdown: give active WebSocket matches 5 s to finish
      kill_timeout: 5000,
      wait_ready: false,
      listen_timeout: 8000,

      env: {
        NODE_ENV: 'production',
        PORT: 3000
      },

      // Structured logs stored beside the repo
      out_file: './logs/teza-out.log',
      error_file: './logs/teza-err.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true
    }
  ]
}
