// ── Fetch text content from a URL (strips HTML) ──
async function fetchSource(url, timeoutMs = 6000) {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const html = await resp.text();
  // Strip scripts, styles, HTML tags → plain text
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#\d+;/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 4000);
}

// ── Pre-fetch bus strike sources from the web ──
async function fetchStrikeSources() {
  const sources = [
    { name: 'parodebondis.com.ar', url: 'https://parodebondis.com.ar/' },
    { name: 'TN - paro colectivos', url: 'https://tn.com.ar/buscar/?q=paro+colectivos+hoy' },
    { name: 'Infobae - paro colectivos', url: 'https://www.infobae.com/tag/paro-de-colectivos/' },
  ];

  const results = await Promise.allSettled(
    sources.map(async (s) => {
      const text = await fetchSource(s.url);
      return { name: s.name, content: text };
    })
  );

  return results
    .filter(r => r.status === 'fulfilled' && r.value.content.length > 50)
    .map(r => r.value);
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (!anthropicKey && !openaiKey) {
    return res.status(500).json({ error: 'No API keys configured' });
  }

  // ── Try Anthropic first ──
  if (anthropicKey) {
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(req.body),
      });

      const data = await response.json();

      if (response.ok) {
        data._provider = 'anthropic';
        return res.status(200).json(data);
      }

      // Check if it's a credit/rate limit error that warrants fallback to OpenAI
      const shouldFallback =
        response.status === 429 ||
        response.status === 529 ||
        data?.error?.type === 'rate_limit_error' ||
        data?.error?.type === 'overloaded_error' ||
        data?.error?.type === 'authentication_error' ||
        (data?.error?.message || '').toLowerCase().includes('credit') ||
        (data?.error?.message || '').toLowerCase().includes('quota') ||
        (data?.error?.message || '').toLowerCase().includes('billing');

      if (!shouldFallback || !openaiKey) {
        return res.status(response.status).json(data);
      }

      // Fall through to OpenAI fallback
    } catch (error) {
      if (!openaiKey) {
        return res.status(500).json({ error: error.message });
      }
      // Fall through to OpenAI fallback
    }
  }

  // ── Fallback to OpenAI (ChatGPT) with pre-fetched sources + web search ──
  if (!openaiKey) {
    return res.status(500).json({ error: 'No fallback API key configured' });
  }

  try {
    // Pre-fetch strike data from sources server-side
    const scrapedSources = await fetchStrikeSources();
    const sourceContext = scrapedSources.length > 0
      ? '\n\nDATOS OBTENIDOS DE FUENTES WEB (USAR ESTOS DATOS COMO BASE):\n' +
        scrapedSources.map(s => `\n--- ${s.name} ---\n${s.content}`).join('\n')
      : '';

    // Build the user message content
    const userContent = (req.body.messages || []).map(m =>
      typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map(c => c.text || '').join('\n')
          : String(m.content)
    ).join('\n');

    const input = [
      {
        role: 'system',
        content: `Sos un asistente que monitorea paros de colectivos en Buenos Aires, Argentina.
REGLAS OBLIGATORIAS:
- Se te proporcionan datos de fuentes web ya descargadas. USÁ ESOS DATOS como fuente principal.
- También podés complementar con búsqueda web si necesitás más info.
- Si los datos de las fuentes mencionan paros, líneas afectadas, o medidas de fuerza, REPORTALOS.
- NO digas "no hay paros" a menos que las fuentes lo confirmen explícitamente.
- Respondé SOLO con JSON puro, sin markdown, sin backticks, sin texto extra.`
      },
      {
        role: 'user',
        content: userContent + sourceContext,
      }
    ];

    // Use OpenAI Responses API with web search as supplement
    const openaiResponse = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        input,
        tools: [{
          type: 'web_search_preview',
          user_location: {
            type: 'approximate',
            country: 'AR',
            city: 'Buenos Aires',
            region: 'Buenos Aires',
            timezone: 'America/Argentina/Buenos_Aires',
          },
          search_context_size: 'high',
        }],
      }),
    });

    const openaiData = await openaiResponse.json();

    if (!openaiResponse.ok) {
      return res.status(openaiResponse.status).json({
        error: openaiData.error?.message || 'OpenAI API error',
      });
    }

    // Extract text from Responses API output
    let text = openaiData.output_text || '';

    if (!text && openaiData.output) {
      for (const item of openaiData.output) {
        if (item.type === 'message' && item.content) {
          for (const block of item.content) {
            if (block.type === 'output_text' && block.text) {
              text += block.text;
            }
          }
        }
      }
    }

    // Strip URL citation annotations that OpenAI injects (e.g. 【6†source】)
    text = text.replace(/【\d+†[^】]*】/g, '');

    // Convert to Anthropic-compatible format
    return res.status(200).json({
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      model: openaiData.model || 'gpt-4o',
      _provider: 'openai',
      _sources_fetched: scrapedSources.map(s => s.name),
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
