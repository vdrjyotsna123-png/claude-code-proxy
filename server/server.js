const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const ClaudeRequest = require('./ClaudeRequest');
const Logger = require('./Logger');
const OAuthManager = require('./OAuthManager');
const OpenAIConverter = require('./OpenAIConverter');
const { exec } = require('child_process');

let config = {};

// PKCE state storage with automatic expiration (10 minutes)
const pkceStates = new Map();
const PKCE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

function cleanupExpiredPKCE() {
  const now = Date.now();
  for (const [state, data] of pkceStates.entries()) {
    if (now - data.created_at > PKCE_EXPIRY_MS) {
      pkceStates.delete(state);
    }
  }
}

// Cleanup expired PKCE states every minute
setInterval(cleanupExpiredPKCE, 60000);

function loadConfig() {
  try {
    const configPath = path.join(__dirname, 'config.txt');
    const configFile = fs.readFileSync(configPath, 'utf8');
    
    configFile.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...valueParts] = trimmed.split('=');
        const value = valueParts.join('=').trim();
        const commentIndex = value.indexOf('#');
        config[key.trim()] = commentIndex >= 0 ? value.substring(0, commentIndex).trim() : value;
      }
    });
    
    Logger.init(config);
    
    Logger.info('Config loaded from config.txt');
  } catch (error) {
    Logger.error('Failed to load config:', error.message);
    process.exit(1);
  }
}


function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(new Error(`Invalid JSON: ${error.message}`));
      }
    });
    req.on('error', reject);
  });
}

function getClientIP(req) {
  return req.headers['x-forwarded-for'] ||
         req.headers['x-real-ip'] ||
         req.connection.remoteAddress ||
         '127.0.0.1';
}

function serveStaticFile(res, filePath, contentType) {
  const staticPath = path.join(__dirname, 'static', filePath);
  fs.readFile(staticPath, 'utf8', (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

function openBrowser(url) {
  let command;
  if (process.platform === 'darwin') {
    command = `open "${url}"`;
  } else if (process.platform === 'win32') {
    // start is a shell built-in; first quoted arg is window title, so use empty title
    command = `cmd /c start "" "${url}"`;
  } else {
    command = `xdg-open "${url}"`;
  }

  exec(command, (error) => {
    if (error) {
      Logger.debug(`Failed to open browser: ${error.message}`);
    }
  });
}

function isRunningInDocker() {
  // Check for /.dockerenv file (Docker creates this)
  if (fs.existsSync('/.dockerenv')) return true;

  // Check /proc/self/cgroup for docker/containerd (Linux)
  try {
    const cgroup = fs.readFileSync('/proc/self/cgroup', 'utf8');
    return cgroup.includes('docker') || cgroup.includes('containerd');
  } catch (err) {
    return false;
  }
}

async function handleRequest(req, res) {
  const clientIP = getClientIP(req);
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  Logger.info(`${req.method} ${pathname} from ${clientIP}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // OAuth Routes
  if (pathname === '/auth/login' && req.method === 'GET') {
    serveStaticFile(res, 'login.html', 'text/html');
    return;
  }

  if (pathname === '/auth/get-url' && req.method === 'GET') {
    try {
      const pkce = OAuthManager.generatePKCE();
      pkceStates.set(pkce.state, {
        code_verifier: pkce.code_verifier,
        created_at: Date.now()
      });

      const authUrl = OAuthManager.buildAuthorizationURL(pkce);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url: authUrl, state: pkce.state }));
      Logger.info('Generated OAuth authorization URL');
    } catch (error) {
      Logger.error('OAuth get-url error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to generate OAuth URL' }));
    }
    return;
  }

  if (pathname === '/auth/callback' && req.method === 'GET') {
    try {
      const query = parsedUrl.query;
      let code = query.code;
      let state = query.state;

      // Handle manual code entry format: "code#state"
      if (query.manual_code) {
        const parts = query.manual_code.split('#');
        if (parts.length !== 2) {
          throw new Error('Invalid code format. Expected: code#state');
        }
        code = parts[0];
        state = parts[1];
      }

      if (!code || !state) {
        throw new Error('Missing authorization code or state');
      }

      const pkceData = pkceStates.get(state);
      if (!pkceData) {
        throw new Error('Invalid or expired state parameter. Please start the authorization process again.');
      }

      pkceStates.delete(state);

      const tokens = await OAuthManager.exchangeCodeForTokens(code, pkceData.code_verifier, state);

      const tokenData = {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: Date.now() + (tokens.expires_in * 1000)
      };
      OAuthManager.saveTokens(tokenData);

      serveStaticFile(res, 'callback.html', 'text/html');
      Logger.info('OAuth authentication successful');
    } catch (error) {
      Logger.error('OAuth callback error:', error.message);
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>Authentication Failed</title></head>
        <body>
          <h1>Authentication Failed</h1>
          <p>Error: ${error.message}</p>
          <p><a href="/auth/login">Try again</a></p>
        </body>
        </html>
      `);
    }
    return;
  }

  if (pathname === '/auth/status' && req.method === 'GET') {
    try {
      const isAuthenticated = OAuthManager.isAuthenticated();
      const expiration = OAuthManager.getTokenExpiration();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        authenticated: isAuthenticated,
        expires_at: expiration ? expiration.toISOString() : null
      }));
    } catch (error) {
      Logger.error('Auth status error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to check authentication status' }));
    }
    return;
  }

  if (pathname === '/auth/logout' && req.method === 'GET') {
    try {
      OAuthManager.logout();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Logged out successfully' }));
      Logger.info('User logged out');
    } catch (error) {
      Logger.error('Logout error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to logout' }));
    }
    return;
  }

  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', server: 'claude-code-proxy', timestamp: Date.now() }));
    return;
  }
  
  if (req.method === 'POST' && (pathname === '/v1/messages' || pathname.match(/^\/v1\/\w+\/messages$/))) {
    try {
      Logger.debug('Incoming request headers:', JSON.stringify(req.headers, null, 2));
      const body = await parseBody(req);
      Logger.debug(`Claude request body (${JSON.stringify(body).length} bytes):`, JSON.stringify(body, null, 2));

      let presetName = null;
      const presetMatch = pathname.match(/^\/v1\/(\w+)\/messages$/);
      if (presetMatch) {
        presetName = presetMatch[1];
        Logger.debug(`Detected preset: ${presetName}`);
      }

      await new ClaudeRequest(req).handleResponse(res, body, presetName);
    } catch (error) {
      Logger.error('Request error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // OpenAI-compatible chat completions endpoint
  if (req.method === 'POST' && pathname === '/v1/chat/completions') {
    try {
      Logger.info('OpenAI-compatible chat completion request');
      Logger.debug('Incoming request headers:', JSON.stringify(req.headers, null, 2));

      const openaiBody = await parseBody(req);
      Logger.debug(`OpenAI request body (${JSON.stringify(openaiBody).length} bytes):`, JSON.stringify(openaiBody, null, 2));

      // Convert OpenAI format to Anthropic format
      const anthropicBody = OpenAIConverter.convertRequestToAnthropic(openaiBody);
      Logger.debug(`Converted Anthropic body (${JSON.stringify(anthropicBody).length} bytes):`, JSON.stringify(anthropicBody, null, 2));

      // Store original model for response conversion
      const originalModel = openaiBody.model;
      const requestId = `chatcmpl-${Date.now()}`;
      const isStreaming = openaiBody.stream === true;

      // Create ClaudeRequest instance for auth handling
      const claudeReq = new ClaudeRequest(req);

      if (isStreaming) {
        await handleOpenAIStreamingRequest(res, claudeReq, anthropicBody, requestId, originalModel);
      } else {
        await handleOpenAINonStreamingRequest(res, claudeReq, anthropicBody, requestId, originalModel);
      }
    } catch (error) {
      Logger.error('OpenAI request error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(OpenAIConverter.convertErrorToOpenAI({ message: error.message }, 500)));
    }
    return;
  }

  // OpenAI-compatible models endpoint - fetches from Anthropic API
  if (req.method === 'GET' && pathname === '/v1/models') {
    Logger.info('OpenAI-compatible models list request');
    try {
      const anthropicModels = await fetchAnthropicModels(req);
      const openaiModels = OpenAIConverter.convertModelsToOpenAI(anthropicModels);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(openaiModels));
    } catch (error) {
      Logger.warn('Failed to fetch models from Anthropic, using fallback:', error.message);
      const fallbackModels = OpenAIConverter.getFallbackModels();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fallbackModels));
    }
    return;
  }
  
  
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

// Helper function to fetch models from Anthropic API
async function fetchAnthropicModels(req) {
  const https = require('https');

  // Create a ClaudeRequest to get auth token (pass null for req if not available)
  const claudeReq = new ClaudeRequest(req || null);
  const token = await claudeReq.getAuthToken();

  if (!token) {
    throw new Error('No auth token available');
  }

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.anthropic.com',
      port: 443,
      path: '/v1/models',
      method: 'GET',
      headers: {
        'Authorization': token,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
        'User-Agent': 'claude-code-proxy/1.0.0'
      }
    };

    const request = https.request(options, (response) => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        if (response.statusCode === 200) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('Invalid JSON response from Anthropic'));
          }
        } else {
          Logger.debug(`Models API response (${response.statusCode}): ${data.substring(0, 200)}`);
          reject(new Error(`Anthropic API returned ${response.statusCode}`));
        }
      });
    });

    request.on('error', reject);
    request.setTimeout(10000, () => {
      request.destroy();
      reject(new Error('Request timeout'));
    });
    request.end();
  });
}

// Helper function for OpenAI-compatible streaming requests
async function handleOpenAIStreamingRequest(res, claudeReq, anthropicBody, requestId, originalModel) {
  // Set headers for SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  try {
    // Process the body to add cache control (without Claude Code system prompt)
    const processedBody = claudeReq.processOpenAIRequestBody(anthropicBody);
    const claudeResponse = await claudeReq.makeRequest(processedBody);

    if (claudeResponse.statusCode !== 200) {
      // Handle error response
      let errorData = '';
      claudeResponse.on('data', chunk => errorData += chunk);
      claudeResponse.on('end', () => {
        try {
          const errorJson = JSON.parse(errorData);
          const errorChunk = {
            id: requestId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: originalModel,
            choices: [{
              index: 0,
              delta: { content: `Error: ${errorJson.error?.message || 'Unknown error'}` },
              finish_reason: 'stop'
            }]
          };
          res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
        } catch (e) {
          Logger.error('Failed to parse error response:', errorData.substring(0, 200));
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
      return;
    }

    // Create transformer and pipe through it
    const transformer = OpenAIConverter.createStreamTransformer(requestId, originalModel, claudeReq);

    claudeResponse.on('error', (err) => {
      Logger.error('Claude streaming error:', err.message);
      res.write('data: [DONE]\n\n');
      res.end();
    });

    res.on('close', () => {
      Logger.debug('Client disconnected from OpenAI stream');
      if (!claudeResponse.destroyed) {
        claudeResponse.destroy();
      }
    });

    claudeResponse.pipe(transformer).pipe(res);

    transformer.on('end', () => {
      Logger.debug('OpenAI streaming response completed');
    });
  } catch (error) {
    Logger.error('Streaming request error:', error.message);
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

// Helper function for OpenAI-compatible non-streaming requests
async function handleOpenAINonStreamingRequest(res, claudeReq, anthropicBody, requestId, originalModel) {
  try {
    // Ensure non-streaming
    anthropicBody.stream = false;

    // Process the body to add cache control (without Claude Code system prompt)
    const processedBody = claudeReq.processOpenAIRequestBody(anthropicBody);
    const claudeResponse = await claudeReq.makeRequest(processedBody);

    let responseData = '';
    claudeResponse.on('data', chunk => responseData += chunk);

    claudeResponse.on('end', () => {
      try {
        const anthropicData = JSON.parse(responseData);

        if (claudeResponse.statusCode !== 200) {
          // Convert Anthropic error to OpenAI format
          res.writeHead(claudeResponse.statusCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(OpenAIConverter.convertErrorToOpenAI(anthropicData, claudeResponse.statusCode)));
          return;
        }

        // Log cache usage for OpenAI non-streaming responses
        if (anthropicData.usage) {
          claudeReq.logCacheUsage(anthropicData.usage);
        }

        const openaiResponse = OpenAIConverter.convertResponseToOpenAI(
          anthropicData,
          requestId,
          originalModel
        );

        Logger.debug('OpenAI non-streaming response:', JSON.stringify(openaiResponse, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(openaiResponse));
      } catch (e) {
        Logger.error('Response conversion error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(OpenAIConverter.convertErrorToOpenAI({ message: 'Failed to convert response' }, 500)));
      }
    });

    claudeResponse.on('error', (err) => {
      Logger.error('Claude non-streaming error:', err.message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(OpenAIConverter.convertErrorToOpenAI({ message: err.message }, 502)));
    });
  } catch (error) {
    Logger.error('Non-streaming request error:', error.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(OpenAIConverter.convertErrorToOpenAI({ message: error.message }, 500)));
  }
}

function startServer() {
  loadConfig();

  const server = http.createServer(handleRequest);
  const port = parseInt(config.port) || 3000;

  // Smart host binding: auto-detect Docker or use config
  const host = config.host || (isRunningInDocker() ? '0.0.0.0' : '127.0.0.1');

  server.listen(port, host, () => {
    Logger.info(`claude-code-proxy server listening on ${host}:${port}`);

    // Display authentication status
    const isAuthenticated = OAuthManager.isAuthenticated();
    const expiration = OAuthManager.getTokenExpiration();

    Logger.info('');
    Logger.info('Authentication Status:');
    if (isAuthenticated && expiration) {
      Logger.info(`  ✓ Authenticated until ${expiration.toLocaleString()}`);
    } else {
      Logger.info('  ✗ Not authenticated');
      const authUrl = `http://localhost:${port}/auth/login`;
      Logger.info(`  → Visit ${authUrl} to authenticate`);

      // Auto-open browser if configured (only works when running natively)
      const autoOpenBrowser = config.auto_open_browser !== 'false';
      if (!isAuthenticated && autoOpenBrowser && !isRunningInDocker()) {
        Logger.info('  → Opening browser for authentication...');
        setTimeout(() => openBrowser(authUrl), 1000);
      }
    }
    Logger.info('');
  });

  process.on('SIGTERM', () => {
    Logger.info('Shutting down...');
    server.close(() => process.exit(0));
  });

  process.on('SIGINT', () => {
    Logger.info('Shutting down...');
    server.close(() => process.exit(0));
  });
}

if (require.main === module) {
  startServer();
}

module.exports = { startServer, ClaudeRequest };
