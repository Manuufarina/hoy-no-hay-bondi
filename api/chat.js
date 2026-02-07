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

  // ── Fallback 1: Google Gemini with Google Search grounding ──
  if (geminiKey) {
    try {
      const userMessages = (req.body.messages || []).map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? m.content.map(c => c.text || '').join('\n')
            : String(m.content) }],
      }));

      const geminiResponse = await fetchWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: {
              parts: [{ text: 'Sos un monitor de transporte público argentino. Tu tarea es buscar en la web información ACTUAL sobre paros de colectivos en Buenos Aires y responder SOLO con JSON puro, sin markdown ni texto extra. Es CRÍTICO que la información sea precisa y verificada: NO inventes líneas afectadas ni paros que no existan. Si no encontrás información sobre paros hoy, respondé con hay_paros: false y lineas_afectadas vacío. Siempre indicá la fuente real de cada dato. Preferí fuentes oficiales y verificadas.' }],
            },
            contents: userMessages,
            tools: [{ google_search: {} }],
          }),
        }
      );

      const geminiData = await geminiResponse.json();

      if (geminiResponse.ok && geminiData.candidates?.[0]?.content?.parts) {
        const text = geminiData.candidates[0].content.parts
          .map(p => p.text || '')
          .join('');

        return res.status(200).json({
          content: [{ type: 'text', text }],
          stop_reason: 'end_turn',
          model: geminiData.modelVersion || 'gemini-2.0-flash',
          _provider: 'gemini',
        });
      }

      // Gemini failed, fall through to OpenAI if available
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
        model: 'gpt-5.2',
        input,
        reasoning: {
          effort: 'high',
          summary: 'auto',
        },
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
      model: openaiData.model || 'gpt-5.2',
      _provider: 'openai',
    });
  } catch (error) {
    const msg = error.name === 'AbortError' ? 'OpenAI API timeout' : error.message;
    return res.status(500).json({ error: msg });
  }
}
