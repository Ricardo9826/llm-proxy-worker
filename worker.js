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

// Helper for retrying fetch requests with exponential backoff
async function fetchWithRetry(request, options = {}, maxRetries = 3, initialDelay = 1000) {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout per attempt

      const response = await fetch(request, {
        ...options,
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      // Retry on 5xx errors (Server Errors)
      if (response.status >= 500 && response.status <= 599) {
        throw new Error(`Server error: ${response.status}`);
      }

      return response;
    } catch (error) {
      lastError = error;
      console.log(`Attempt ${attempt + 1} failed: ${error.message}. Retrying in ${initialDelay * Math.pow(2, attempt)}ms...`);
      if (attempt < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, initialDelay * Math.pow(2, attempt)));
      }
    }
  }
  throw lastError;
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
    
    // Create the new target URL
    const targetUrl = new URL(targetEndpoint);
    targetUrl.pathname = newPathname;
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
      const response = await fetchWithRetry(modifiedRequest, {
        cf: {
          cacheTtl: 3600,
          cacheEverything: true,
        }
      });
      console.log(`Response received with status: ${response.status}`);
      
      // Create a new response with CORS headers
      const modifiedResponse = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
      
      // Add CORS headers
      modifiedResponse.headers.set('Access-Control-Allow-Origin', request.headers.get('Origin') || '*');
      modifiedResponse.headers.set('Access-Control-Allow-Credentials', 'true');
      
      return modifiedResponse;
    } catch (error) {
      console.error(`Error proxying request to ${provider}:`, error);
      return new Response(`Error proxying request to ${provider}: ${error.message}`, { status: 500 });
    }
  }
  
  // If no valid provider is specified in the path
  console.log('Invalid provider path requested');
  return new Response('Invalid LLM provider path. Use /provider/api/path format.', { status: 400 });
}

function handleCORS(request) {
  // Handle CORS preflight requests
  const corsHeaders = {
    'Access-Control-Allow-Origin': request.headers.get('Origin') || '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': request.headers.get('Access-Control-Request-Headers') || 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400'
  };
  
  return new Response(null, {
    status: 204,
    headers: corsHeaders
  });
}

function getLandingPage(request) {
  const baseUrl = new URL(request.url).origin;
  return `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>AI Worker Proxy - 高性能 LLM 代理</title>
      <style>
        :root {
          --primary: #4f46e5;
          --primary-hover: #4338ca;
          --bg: #f8fafc;
          --card-bg: #ffffff;
          --text-main: #1e293b;
          --text-muted: #64748b;
          --border: #e2e8f0;
        }
        body { 
          font-family: 'Inter', system-ui, -apple-system, sans-serif; 
          background: var(--bg); 
          color: var(--text-main); 
          margin: 0; 
          display: flex; 
          justify-content: center; 
          padding: 2rem 1rem;
        }
        .container { 
          max-width: 800px; 
          width: 100%; 
        }
        .card { 
          background: var(--card-bg); 
          padding: 2.5rem; 
          border-radius: 1.5rem; 
          box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1); 
          border: 1px solid var(--border);
        }
        h1 { 
          font-size: 2.25rem; 
          font-weight: 800; 
          color: var(--primary); 
          margin: 0 0 1rem 0; 
          text-align: center;
          letter-spacing: -0.025em;
        }
        .subtitle { 
          text-align: center; 
          color: var(--text-muted); 
          font-size: 1.125rem; 
          margin-bottom: 2.5rem; 
          line-height: 1.6;
        }
        section { 
          margin-bottom: 2rem; 
        }
        h2 { 
          font-size: 1.25rem; 
          font-weight: 600; 
          margin-bottom: 1rem; 
          display: flex; 
          align-items: center; 
          gap: 0.5rem;
          border-bottom: 2px solid var(--bg);
          padding-bottom: 0.5rem;
        }
        .grid { 
          display: grid; 
          grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); 
          gap: 1rem; 
        }
        .endpoint-card { 
          background: var(--bg); 
          padding: 1rem; 
          border-radius: 0.75rem; 
          border: 1px solid var(--border);
          transition: transform 0.2s, border-color 0.2s;
        }
        .endpoint-card:hover { 
          transform: translateY(-2px); 
          border-color: var(--primary); 
        }
        .provider-name { 
          font-weight: 700; 
          color: var(--text-main); 
          font-size: 1rem;
          display: block;
          margin-bottom: 0.5rem;
        }
        .provider-url { 
          font-family: 'JetBrains Mono', monospace; 
          font-size: 0.85rem; 
          color: var(--text-muted); 
          word-break: break-all;
          margin-bottom: 0.25rem;
          display: block;
        }
        .example-box { 
          background: #1e293b; 
          color: #e2e8f0; 
          padding: 1.25rem; 
          border-radius: 0.75rem; 
          font-family: 'JetBrains Mono', monospace; 
          font-size: 0.9rem; 
          line-height: 1.6; 
          overflow-x: auto;
          border-left: 4px solid var(--primary);
        }
        .example-box .keyword { color: #818cf8; }
        .example-box .url { color: #34d399; }
        .footer { 
          text-align: center; 
          margin-top: 2rem; 
          color: var(--text-muted); 
          font-size: 0.875rem; 
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="card">
          <h1>AI Worker Proxy</h1>
          <p class="subtitle">一个轻量级、高性能的 LLM API 转发网关，支持跨域请求 (CORS) 且无需配置复杂后端。</p>
          
          <section>
            <h2>🚀 快速上手</h2>
            <p style="color: var(--text-muted); margin-bottom: 1rem;">
              只需在请求 URL 路径前加上供应商标识即可。例如，要调用 OpenAI 的 API：
            </p>
            <div class="example-box">
              <span class="keyword">POST</span> <span class="url">${baseUrl}/openai/v1/chat/completions</span>
            </div>
          </section>

          <section>
            <h2>🛠️ 支持的供应商</h2>
            <div class="grid">
              ${Object.entries(LLM_ENDPOINTS).map(([p, e]) => `
                <div class="endpoint-card">
                  <span class="provider-name">${p}</span>
                  <span class="provider-url">官网：${e}</span>
                  <span class="provider-url" style="color: var(--primary)">代理：${baseUrl}/${p}</span>
                </div>
              `).join('')}
            </div>
          </section>

          <section>
            <h2>💡 使用技巧</h2>
            <ul style="color: var(--text-muted); line-height: 1.8; padding-left: 1.25rem;">
              <li><strong>跨域支持</strong>：默认开启 CORS，支持所有来源请求。</li>
              <li><strong>Header 传递</strong>：所有标准请求头（如 <code style="background:#eee; padding:2px 4px; border-radius:4px">Authorization</code>）将原样转发。</li>
              <li><strong>路径映射</strong>：<code>/provider/rest/of/path</code> &rarr; <code>LLM_ENDPOINTS[provider] + /rest/of/path</code></li>
            </ul>
          </section>
        </div>
        <div class="footer">
          Powered by Cloudflare Workers & <a href="https://github.com/Ricardo9826/llm-proxy-worker" style="color: var(--primary); text-decoration: underline;">GitHub</a>
        </div>
      </div>
    </body>
    </html>
  `;
} 
