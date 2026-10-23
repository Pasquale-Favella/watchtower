const fs = require('node:fs')
const path = require('node:path')
function prepareProviderFixture(profile) {
  const home = path.join(profile, 'isolated-home')
  const codexHome = path.join(profile, 'provider-fixtures', 'codex')
  const projectPath = path.join(profile, 'provider-fixtures', 'workspace', 'packaged-project')
  const now = new Date().toISOString()
  const year = now.slice(0, 4)
  const month = now.slice(5, 7)
  const day = now.slice(8, 10)
  const sessionPath = path.join(codexHome, 'sessions', year, month, day, 'rollout-packaged-acceptance.jsonl')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(projectPath, { recursive: true })
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true })
  const tokenUsage = {
    input_tokens: 32,
    cached_input_tokens: 0,
    output_tokens: 16,
    reasoning_output_tokens: 0,
    total_tokens: 48,
  }
  const entries = [
    {
      type: 'session_meta',
      timestamp: now,
      payload: {
        session_id: 'watchtower-packaged-session',
        cwd: projectPath,
        originator: 'Codex CLI',
        model: 'gpt-5.2-codex',
      },
    },
    {
      type: 'response_item',
      timestamp: now,
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'watchtower-packaged-unique-search-needle' }],
      },
    },
    {
      type: 'response_item',
      timestamp: now,
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Packaged scan fixture response.' }],
      },
    },
    {
      type: 'event_msg',
      timestamp: now,
      payload: {
        type: 'token_count',
        info: {
          model: 'gpt-5.2-codex',
          last_token_usage: tokenUsage,
          total_token_usage: tokenUsage,
        },
      },
    },
  ]
  fs.writeFileSync(sessionPath, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n')
  return {
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(profile, 'isolated-appdata'),
      CODEX_HOME: codexHome,
      LOCALAPPDATA: path.join(profile, 'isolated-localappdata'),
      XDG_CONFIG_HOME: path.join(profile, 'isolated-xdg-config'),
      XDG_DATA_HOME: path.join(profile, 'isolated-xdg-data'),
      CLAUDE_CONFIG_DIRS: path.join(profile, 'isolated-claude-config'),
      WATCHTOWER_DESKTOP_SESSIONS_DIR: path.join(profile, 'isolated-claude-desktop'),
    },
  }
}

module.exports = { prepareProviderFixture }
