// LLM service endpoint mappings
const LLM_ENDPOINTS = {
  'openai': 'https://api.openai.com',
  'anthropic': 'https://api.anthropic.com',
  'gemini': 'https://generativelanguage.googleapis.com',
  'groq': 'https://api.groq.com',
  'sambanova': 'https://api.sambanova.ai',
  'azure': 'https://YOUR_AZURE_RESOURCE_NAME.openai.azure.com',
  // Add more providers as needed
  'nvidia': 'https://integrate.api.nvidia.com',
};

// Helper for retrying fetch requests with exponential backoff.
// Only retries on GET/HEAD requests (safe/idempotent); POST and other
// non-idempotent methods are forwarded once without retry to avoid
// duplicate side-effects (e.g. double billing on LLM completions).
async function fetchWithRetry(request, options = {}, maxRetries = 3, initialDelay = 1000) {
  const isRetryable = ['GET', 'HEAD'].includes(request.method.toUpperCase());
  const effectiveRetries = isRetryable ? maxRetries : 1;
  // 120s timeout — LLM inference (deep thinking, long context) can exceed 30s
  const timeoutMs = 120000;
  
  let lastError;
  for (let attempt = 0; attempt < effectiveRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(request, {
        ...options,
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      // For non-retryable methods, return the response as-is (including 5xx)
      // so the client can decide what to do — especially important for SSE streams.
      if (!isRetryable) {
        return response;
      }

      // Retry on 5xx errors only for safe methods
      if (response.status >= 500 && response.status <= 599) {
        throw new Error(`Server error: ${response.status}`);
      }

      return response;
    } catch (error) {
      lastError = error;
      console.log(`Attempt ${attempt + 1} failed: ${error.message}. Retrying in ${initialDelay * Math.pow(2, attempt)}ms...`);
      if (attempt < effectiveRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, initialDelay * Math.pow(2, attempt)));
      }
    }
  }
  throw lastError;
}

// Build CORS headers that respect the spec: when Allow-Credentials is true,
// Origin must be a concrete value — the wildcard "*" is rejected by browsers.
function corsHeadersForRequest(request) {
  const origin = request.headers.get('Origin');
  if (origin) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
    };
  }
  return { 'Access-Control-Allow-Origin': '*' };
}

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  // Add logging
  console.log(`Incoming request to: ${request.url}`);
  
  // Handle CORS preflight requests
  if (request.method === 'OPTIONS') {
    console.log('Handling CORS preflight request');
    return handleCORS(request);
  }
  
  const url = new URL(request.url);
  const pathParts = url.pathname.split('/').filter(part => part);
  
  // Handle root path
  if (pathParts.length === 0) {
    return new Response(getLandingPage(request), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }

  // Check if the first path segment matches any of our LLM providers
  if (pathParts.length > 0 && LLM_ENDPOINTS[pathParts[0]]) {
    const provider = pathParts[0];
    const targetEndpoint = LLM_ENDPOINTS[provider];
    console.log(`Proxying request to ${provider} at ${targetEndpoint}`);
    
    // Remove the provider prefix from the path
    const newPathname = '/' + pathParts.slice(1).join('/');
    
    // Build target URL, properly appending to any base path in the endpoint.
    // e.g. if targetEndpoint = "https://host/v1beta", newPathname = "/models:generateContent"
    // the result should be "https://host/v1beta/models:generateContent", not override the base path.
    const targetUrl = new URL(targetEndpoint);
    targetUrl.pathname = targetUrl.pathname.replace(/\/$/, '') + newPathname;
    targetUrl.search = url.search;
    
    // Clone the request and modify it for the target API
    const cleanedHeaders = new Headers();
    for (const [key, value] of request.headers) {
      // Skip Cloudflare-specific headers and other headers we want to clean
      if (!key.toLowerCase().startsWith('cf-') && 
          !['x-real-ip', 'x-forwarded-for', 'x-forwarded-proto', 
            'x-forwarded-host', 'x-forwarded-port', 'x-forwarded-scheme',
            'x-forwarded-ssl', 'cdn-loop'].includes(key.toLowerCase())) {
        cleanedHeaders.set(key, value);
      }
    }
    
    const modifiedRequest = new Request(targetUrl.toString(), {
      method: request.method,
      headers: cleanedHeaders,
      body: request.body,
      redirect: 'follow'
    });
    
    // Forward the request to the appropriate LLM API
    try {
      // Mask sensitive headers for logging
      const logHeaders = Object.fromEntries(cleanedHeaders.entries());
      const sensitiveHeaders = ['authorization', 'cookie', 'x-api-key', 'api-key'];
      for (const key of Object.keys(logHeaders)) {
        if (sensitiveHeaders.includes(key.toLowerCase())) {
          logHeaders[key] = '[REDACTED]';
        }
      }
      console.log('Forwarding request with cleaned headers:', 
                  JSON.stringify(logHeaders, null, 2));
      // Only cache safe, read-only list endpoints (e.g. GET /v1/models).
      // Never cache POST completions/chat — responses are unique per prompt.
      const fetchOptions = {};
      if (request.method === 'GET' && /\/(v1\/)?models\/?$/.test(newPathname)) {
        fetchOptions.cf = { cacheTtl: 3600, cacheEverything: true };
      }
      const response = await fetchWithRetry(modifiedRequest, fetchOptions);
      console.log(`Response received with status: ${response.status}`);
      
      // Create a new response with CORS headers
      const modifiedResponse = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
      
      // Add CORS headers — when Allow-Credentials is true, Origin must be a
      // specific value, not the wildcard "*"; browsers reject the combination.
      const cors = corsHeadersForRequest(request);
      for (const [k, v] of Object.entries(cors)) {
        modifiedResponse.headers.set(k, v);
      }
      
      return modifiedResponse;
    } catch (error) {
      console.error(`Error proxying request to ${provider}:`, error);
      // Error responses also need CORS headers for browser clients
      const errorHeaders = { 'Content-Type': 'text/plain', ...corsHeadersForRequest(request) };
      return new Response(`Error proxying request to ${provider}: ${error.message}`, { status: 500, headers: errorHeaders });
    }
  }
  
  // If no valid provider is specified in the path
  console.log('Invalid provider path requested');
  return new Response('Invalid LLM provider path. Use /provider/api/path format.', {
    status: 400,
    headers: { 'Content-Type': 'text/plain', ...corsHeadersForRequest(request) }
  });
}

function handleCORS(request) {
  const corsHeaders = {
    ...corsHeadersForRequest(request),
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': request.headers.get('Access-Control-Request-Headers') || 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
  
  return new Response(null, {
    status: 204,
    headers: corsHeaders
  });
}

function getLandingPage(request) {
  const baseUrl = new URL(request.url).origin;
  const providers = Object.entries(LLM_ENDPOINTS);
  return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Worker Proxy</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    :root{
      --bg:#0a0a0f;
      --surface:#12121a;
      --surface2:#1a1a26;
      --border:#2a2a3a;
      --text:#e2e8f0;
      --text-muted:#8b8ba0;
      --accent:#6366f1;
      --accent-glow:rgba(99,102,241,.25);
      --green:#34d399;
      --font-sans:'Inter',system-ui,-apple-system,sans-serif;
      --font-mono:'JetBrains Mono','Fira Code',monospace;
    }
    body{
      font-family:var(--font-sans);
      background:var(--bg);
      color:var(--text);
      min-height:100vh;
      display:flex;
      flex-direction:column;
      align-items:center;
    }
    .hero{
      width:100%;
      padding:4rem 1.5rem 3rem;
      text-align:center;
      background:radial-gradient(ellipse 60% 50% at 50% 0%,var(--accent-glow),transparent);
    }
    .hero h1{
      font-size:2.75rem;
      font-weight:800;
      letter-spacing:-.04em;
      background:linear-gradient(135deg,#818cf8,#6366f1,#a78bfa);
      -webkit-background-clip:text;
      -webkit-text-fill-color:transparent;
      background-clip:text;
      margin-bottom:.75rem;
    }
    .hero p{
      color:var(--text-muted);
      font-size:1.1rem;
      max-width:560px;
      margin:0 auto;
      line-height:1.7;
    }
    .main{
      width:100%;
      max-width:960px;
      padding:0 1.5rem 3rem;
    }
    .section-title{
      font-size:1rem;
      font-weight:600;
      color:var(--text-muted);
      text-transform:uppercase;
      letter-spacing:.08em;
      margin:2.5rem 0 1rem;
      display:flex;
      align-items:center;
      gap:.5rem;
    }
    .section-title::after{
      content:'';
      flex:1;
      height:1px;
      background:var(--border);
    }
    .quickstart{
      background:var(--surface);
      border:1px solid var(--border);
      border-radius:12px;
      padding:1.25rem 1.5rem;
      position:relative;
      overflow:hidden;
    }
    .quickstart::before{
      content:'';
      position:absolute;
      left:0;top:0;bottom:0;
      width:3px;
      background:var(--accent);
    }
    .quickstart .method{
      font-family:var(--font-mono);
      font-size:.8rem;
      color:var(--accent);
      font-weight:700;
      margin-bottom:.35rem;
      letter-spacing:.04em;
    }
    .quickstart .url{
      font-family:var(--font-mono);
      font-size:.92rem;
      color:var(--green);
      word-break:break-all;
      line-height:1.5;
    }
    .grid{
      display:grid;
      grid-template-columns:repeat(auto-fill,minmax(280px,1fr));
      gap:.75rem;
    }
    .card{
      background:var(--surface);
      border:1px solid var(--border);
      border-radius:12px;
      padding:1.1rem 1.25rem;
      transition:border-color .2s,box-shadow .2s;
      cursor:default;
    }
    .card:hover{
      border-color:var(--accent);
      box-shadow:0 0 20px var(--accent-glow);
    }
    .card .name{
      font-weight:700;
      font-size:.95rem;
      margin-bottom:.45rem;
      display:flex;
      align-items:center;
      gap:.4rem;
    }
    .card .name .dot{
      width:8px;height:8px;
      border-radius:50%;
      background:var(--green);
      display:inline-block;
      flex-shrink:0;
    }
    .card .meta{
      font-family:var(--font-mono);
      font-size:.78rem;
      color:var(--text-muted);
      line-height:1.7;
    }
    .card .meta span{
      display:block;
      word-break:break-all;
    }
    .card .meta .proxy{
      color:var(--accent);
    }
    .tips{
      list-style:none;
      display:grid;
      grid-template-columns:repeat(auto-fill,minmax(280px,1fr));
      gap:.75rem;
    }
    .tips li{
      background:var(--surface);
      border:1px solid var(--border);
      border-radius:12px;
      padding:1rem 1.25rem;
      font-size:.9rem;
      color:var(--text-muted);
      line-height:1.6;
    }
    .tips li strong{
      color:var(--text);
      display:block;
      margin-bottom:.2rem;
    }
    .tips li code{
      font-family:var(--font-mono);
      font-size:.8rem;
      background:var(--surface2);
      padding:2px 6px;
      border-radius:4px;
      border:1px solid var(--border);
    }
    .footer{
      text-align:center;
      padding:2rem 1rem;
      color:var(--text-muted);
      font-size:.8rem;
      border-top:1px solid var(--border);
      width:100%;
    }
    .footer a{
      color:var(--accent);
      text-decoration:none;
    }
    .footer a:hover{text-decoration:underline}
    @media(max-width:640px){
      .hero h1{font-size:1.75rem}
      .hero p{font-size:.95rem}
      .grid{grid-template-columns:1fr}
      .tips{grid-template-columns:1fr}
    }
  </style>
</head>
<body>
  <div class="hero">
    <h1>AI Worker Proxy</h1>
    <p>轻量级 LLM API 转发网关 — 跨域即开即用，零配置接入多家供应商</p>
  </div>

  <div class="main">
    <div class="section-title">快速上手</div>
    <div class="quickstart">
      <div class="method">POST</div>
      <div class="url">${baseUrl}/openai/v1/chat/completions</div>
    </div>

    <div class="section-title">支持的供应商</div>
    <div class="grid">
      ${providers.map(([p, e]) => `
      <div class="card">
        <div class="name"><span class="dot"></span>${p}</div>
        <div class="meta">
          <span>${e}</span>
          <span class="proxy">${baseUrl}/${p}</span>
        </div>
      </div>`).join('')}
    </div>

    <div class="section-title">使用说明</div>
    <ul class="tips">
      <li><strong>路径映射</strong>在请求 URL 前加供应商标识，格式 <code>/provider/api/path</code></li>
      <li><strong>跨域支持</strong>默认启用 CORS，浏览器可直接调用，无需额外配置</li>
      <li><strong>Header 透传</strong><code>Authorization</code> 等标准请求头原样转发至上游</li>
      <li><strong>安全重试</strong>仅 GET 请求自动重试 5xx，POST 等非幂等请求不重试</li>
      <li><strong>长推理兼容</strong>120 秒超时，支持 deep thinking 等长耗时推理场景</li>
    </ul>
  </div>

  <div class="footer">
    Powered by Cloudflare Workers · <a href="https://github.com/Ricardo9826/llm-proxy-worker">GitHub</a>
  </div>
</body>
</html>`;
} 
