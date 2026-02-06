export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const FETCH_TIMEOUT = 50000; // 50s timeout for upstream API calls

  if (!anthropicKey && !geminiKey && !openaiKey) {
    return res.status(500).json({ error: 'No API keys configured' });
  }

  // Helper: fetch with timeout
  async function fetchWithTimeout(url, options) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ── Try Anthropic first ──
  if (anthropicKey) {
    try {
      const response = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
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

      if (!shouldFallback || (!geminiKey && !openaiKey)) {
        return res.status(response.status).json(data);
      }

      // Fall through to Gemini / OpenAI fallback
    } catch (error) {
      if (!geminiKey && !openaiKey) {
        const msg = error.name === 'AbortError' ? 'Anthropic API timeout' : error.message;
        return res.status(500).json({ error: msg });
      }
      // Fall through to Gemini / OpenAI fallback
    }
  }

  // ── Fallback 1: Google Gemini ──
  if (geminiKey) {
    try {
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`;
      const geminiSystemPrompt = 'Sos un monitor de transporte público argentino. Tu tarea es buscar en la web información ACTUAL sobre paros de colectivos en Buenos Aires y responder SOLO con JSON puro, sin markdown ni texto extra. Es CRÍTICO que la información sea precisa y verificada: NO inventes líneas afectadas ni paros que no existan. Si no encontrás información sobre paros hoy, respondé con hay_paros: false y lineas_afectadas vacío. Siempre indicá la fuente real de cada dato. Preferí fuentes oficiales y verificadas.';
      const geminiMessages = (req.body.messages || []).map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? m.content.map(c => c.text || '').join('\n')
            : String(m.content) }],
      }));

      // Helper: extract text from Gemini response
      function extractGeminiText(data) {
        const parts = data?.candidates?.[0]?.content?.parts;
        if (!parts) return null;
        const text = parts.map(p => p.text || '').join('');
        return text || null;
      }

      // Attempt 1: with Google Search grounding
      let geminiResponse = await fetchWithTimeout(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: geminiSystemPrompt }] },
          contents: geminiMessages,
          tools: [{ google_search: {} }],
        }),
      });

      let geminiData = await geminiResponse.json();
      let geminiText = geminiResponse.ok ? extractGeminiText(geminiData) : null;

      // Attempt 2: if Google Search failed (billing, quota, tool not available), retry without it
      if (!geminiText) {
        const errMsg = (geminiData?.error?.message || '').toLowerCase();
        const errStatus = geminiData?.error?.status || '';
        const isSearchError =
          !geminiResponse.ok ||
          errStatus === 'RESOURCE_EXHAUSTED' ||
          errStatus === 'FAILED_PRECONDITION' ||
          errStatus === 'PERMISSION_DENIED' ||
          errMsg.includes('quota') ||
          errMsg.includes('billing') ||
          errMsg.includes('credit') ||
          errMsg.includes('google_search') ||
          errMsg.includes('not enabled') ||
          errMsg.includes('not supported') ||
          errMsg.includes('exhausted');

        if (isSearchError) {
          geminiResponse = await fetchWithTimeout(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: geminiSystemPrompt }] },
              contents: geminiMessages,
            }),
          });
          geminiData = await geminiResponse.json();
          geminiText = geminiResponse.ok ? extractGeminiText(geminiData) : null;
        }
      }

      if (geminiText) {
        return res.status(200).json({
          content: [{ type: 'text', text: geminiText }],
          stop_reason: 'end_turn',
          model: geminiData.modelVersion || 'gemini-2.0-flash',
          _provider: 'gemini',
        });
      }

      // Gemini failed completely, fall through to OpenAI if available
      if (!openaiKey) {
        return res.status(geminiResponse.status || 500).json({
          error: geminiData.error?.message || 'Gemini API error',
        });
      }
    } catch (error) {
      if (!openaiKey) {
        const msg = error.name === 'AbortError' ? 'Gemini API timeout' : error.message;
        return res.status(500).json({ error: msg });
      }
      // Fall through to OpenAI fallback
    }
  }

  // ── Fallback 2: OpenAI (ChatGPT) with web search ──
  if (!openaiKey) {
    return res.status(500).json({ error: 'No fallback API key configured' });
  }

  try {
    // Build input for OpenAI Responses API with system instruction
    const userMessages = (req.body.messages || []).map(m => ({
      role: m.role,
      content: typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map(c => c.text || '').join('\n')
          : String(m.content),
    }));

    const input = [
      {
        role: 'developer',
        content: 'Sos un monitor de transporte público argentino. Tu tarea es buscar en la web información ACTUAL sobre paros de colectivos en Buenos Aires y responder SOLO con JSON puro, sin markdown ni texto extra. Es CRÍTICO que la información sea precisa y verificada: NO inventes líneas afectadas ni paros que no existan. Si no encontrás información sobre paros hoy, respondé con hay_paros: false y lineas_afectadas vacío. Siempre indicá la fuente real de cada dato. Preferí fuentes oficiales y verificadas.'
      },
      ...userMessages
    ];

    // Use OpenAI Responses API with web search enabled
    const openaiResponse = await fetchWithTimeout('https://api.openai.com/v1/responses', {
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
    // output_text is a shortcut, or we can parse output array
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

    // Convert to Anthropic-compatible format
    return res.status(200).json({
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      model: openaiData.model || 'gpt-4o',
      _provider: 'openai',
    });
  } catch (error) {
    const msg = error.name === 'AbortError' ? 'OpenAI API timeout' : error.message;
    return res.status(500).json({ error: msg });
  }
}
